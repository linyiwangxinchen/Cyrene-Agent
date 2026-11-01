"""Model source, local loading, and failure boundaries without network/model weights."""
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
import asr_model


def write_model(directory, missing=None):
    directory.mkdir(parents=True, exist_ok=True)
    for name in (*asr_model.REQUIRED_FILES, "vocabulary.txt"):
        if name != missing:
            (directory / name).write_text("fixture", encoding="utf-8")


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cyrene-model-test-")
        self.home = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.environment = patch.dict(os.environ)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def download_stub(self, fn):
        modules = {"modelscope": types.ModuleType("modelscope"), "modelscope.hub": types.ModuleType("modelscope.hub"),
                   "modelscope.hub.snapshot_download": types.SimpleNamespace(snapshot_download=fn)}
        return patch.dict(sys.modules, modules)

    def test_all_models_use_ct2_repositories_and_local_loading(self):
        for name in ("tiny", "base", "small", "medium"):
            with self.subTest(name=name):
                target = asr_model.model_directory(self.home, name)
                def download(**kwargs):
                    self.assertEqual(kwargs["model_id"], f"pengzhendong/faster-whisper-{name}")
                    self.assertEqual(kwargs["endpoint"], "https://modelscope.cn")
                    self.assertEqual(kwargs["max_workers"], 2)
                    self.assertEqual(kwargs["local_dir"], str(target))
                    self.assertEqual(set(kwargs["allow_patterns"]), set(asr_model.DOWNLOAD_FILES))
                    self.assertFalse(any(p.endswith(".py") for p in kwargs["allow_patterns"]))
                    write_model(target)
                    return str(target)
                whisper = Mock()
                with self.download_stub(download), patch.dict(sys.modules, {"faster_whisper": types.SimpleNamespace(WhisperModel=whisper)}):
                    result = asr_model.install_model(self.home, name)
                self.assertEqual(result["source"], "modelscope")
                self.assertEqual(result["directory"], str(target))
                whisper.assert_called_once_with(str(target), device="cpu", compute_type="int8", local_files_only=True, cpu_threads=2)
                self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")

    def test_download_error_never_loads_or_falls_back_to_hub(self):
        whisper = Mock()
        with self.download_stub(Mock(side_effect=ConnectionError("fixture reset"))), patch.dict(sys.modules, {"faster_whisper": types.SimpleNamespace(WhisperModel=whisper)}):
            with self.assertRaises(ConnectionError):
                asr_model.install_model(self.home, "tiny")
        whisper.assert_not_called()

    def test_missing_tokenizer_rejected_even_when_legacy_cache_exists(self):
        cache = self.home / "model-cache/hub/models--Systran--faster-whisper-tiny"
        write_model(cache / "snapshots" / ("a" * 40))
        (cache / "refs").mkdir()
        (cache / "refs/main").write_text("a" * 40)
        def download(**kwargs):
            write_model(Path(kwargs["local_dir"]), missing="tokenizer.json")
        with self.download_stub(download):
            with self.assertRaisesRegex(ValueError, "下载不完整"):
                asr_model.install_model(self.home, "tiny")

    def test_uninstalled_model_fails_before_importing_downloader(self):
        with patch.dict(sys.modules, {"modelscope": None, "faster_whisper": None, "huggingface_hub": None}):
            with self.assertRaisesRegex(ValueError, "文件不完整"):
                asr_model.load_model(self.home, "tiny")

    def test_legacy_weights_reused_only_from_local_snapshot(self):
        cache = self.home / "model-cache/hub/models--Systran--faster-whisper-small"
        target = cache / "snapshots" / ("a" * 40)
        write_model(target)
        (cache / "refs").mkdir()
        (cache / "refs/main").write_text("a" * 40)
        whisper = Mock()
        with patch.dict(sys.modules, {"modelscope": None, "huggingface_hub": None, "faster_whisper": types.SimpleNamespace(WhisperModel=whisper)}):
            asr_model.load_model(self.home, "small")
        self.assertEqual(whisper.call_args.args[0], str(target))

    def test_arbitrary_models_and_invalid_legacy_refs_are_rejected(self):
        for name in ("../model", "other/remote-repo", "tiny.en"):
            with self.assertRaisesRegex(ValueError, "模型无效"):
                asr_model.model_directory(self.home, name)
        cache = self.home / "model-cache/hub/models--Systran--faster-whisper-small/refs"
        cache.mkdir(parents=True)
        (cache / "main").write_text("../../outside")
        with self.assertRaisesRegex(ValueError, "文件不完整"):
            asr_model.local_model_directory(self.home, "small")


if __name__ == "__main__":
    unittest.main()
