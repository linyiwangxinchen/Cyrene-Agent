"""Download CTranslate2 Whisper weights from ModelScope and load them offline."""
import argparse
import json
import os
from pathlib import Path
import re

MODEL_IDS = {name: f"pengzhendong/faster-whisper-{name}" for name in ("tiny", "base", "small", "medium")}
REQUIRED_FILES = ("config.json", "model.bin", "tokenizer.json")
DOWNLOAD_FILES = [*REQUIRED_FILES, "vocabulary.txt", "vocabulary.json", "preprocessor_config.json"]


def model_directory(home, name):
    if name not in MODEL_IDS:
        raise ValueError("转写模型无效")
    return Path(home).resolve() / "model-cache" / "modelscope" / f"faster-whisper-{name}"


def complete(directory):
    directory = Path(directory)
    try:
        files = [directory / name for name in REQUIRED_FILES]
        vocabulary = [directory / name for name in ("vocabulary.txt", "vocabulary.json")]
        return all(p.is_file() and p.stat().st_size > 0 for p in files) and any(p.is_file() and p.stat().st_size > 0 for p in vocabulary)
    except OSError:
        return False


def local_model_directory(home, name):
    directory = model_directory(home, name)
    if complete(directory):
        return directory
    # Preserve already-installed legacy weights without calling any Hub API.
    cache = Path(home).resolve() / "model-cache" / "hub" / f"models--Systran--faster-whisper-{name}"
    try:
        revision = (cache / "refs" / "main").read_text(encoding="utf-8").strip()
        if re.fullmatch(r"[a-fA-F0-9]{40,64}", revision) and complete(cache / "snapshots" / revision):
            return cache / "snapshots" / revision
    except OSError:
        pass
    raise ValueError("转写模型文件不完整，请在小花园设置重新安装魔搭模型")


def load_model(home, name):
    directory = local_model_directory(home, name)
    # Even an accidental tokenizer fallback must never fetch from Hugging Face.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from faster_whisper import WhisperModel
    return WhisperModel(str(directory), device="cpu", compute_type="int8", local_files_only=True, cpu_threads=2)


def install_model(home, name):
    directory = model_directory(home, name)
    directory.mkdir(parents=True, exist_ok=True)
    os.environ["MODELSCOPE_CACHE"] = str(Path(home).resolve() / "model-cache" / "modelscope-cache")
    os.environ.setdefault("MODELSCOPE_DOWNLOAD_TIMEOUT", "120")
    os.environ.setdefault("MODELSCOPE_DOWNLOAD_MAX_RETRIES", "5")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from modelscope.hub.snapshot_download import snapshot_download
    print(f"正在从魔搭 ModelScope 下载：{MODEL_IDS[name]}", flush=True)
    snapshot_download(
        model_id=MODEL_IDS[name], revision="master", local_dir=str(directory),
        cache_dir=os.environ["MODELSCOPE_CACHE"], allow_patterns=DOWNLOAD_FILES,
        max_workers=2, endpoint="https://modelscope.cn",
    )
    if not complete(directory):
        raise ValueError("魔搭模型下载不完整，缺少模型权重、配置、分词器或词表；可重新安装以继续下载")
    print("魔搭下载完成，正在离线验证 CPU/int8 模型加载", flush=True)
    load_model(home, name)
    return {"model": name, "source": "modelscope", "repo": MODEL_IDS[name], "directory": str(directory)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    parser.add_argument("--model", required=True, choices=tuple(MODEL_IDS))
    args = parser.parse_args()
    print(json.dumps(install_model(args.home, args.model), ensure_ascii=False), flush=True)
