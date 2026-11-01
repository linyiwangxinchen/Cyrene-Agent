"""Verify the production loader and inference with all network connections blocked."""
import argparse
import json
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "extensions/bili-garden/python"))
from asr_model import load_model, model_directory, local_model_directory

parser = argparse.ArgumentParser()
parser.add_argument("--home", required=True)
parser.add_argument("--model", default="tiny")
parser.add_argument("--audio")
args = parser.parse_args()
expected = model_directory(args.home, args.model)
assert local_model_directory(args.home, args.model) == expected, "Expected ModelScope weights"
with patch("socket.socket.connect", side_effect=AssertionError("offline inference attempted a network connection")), \
     patch("socket.create_connection", side_effect=AssertionError("offline inference attempted a network connection")):
    import numpy as np
    model = load_model(args.home, args.model)
    source = args.audio or np.zeros(16000, dtype=np.float32)
    segments, info = model.transcribe(source, language="en", vad_filter=False, beam_size=1, condition_on_previous_text=False)
    text = " ".join(segment.text.strip() for segment in segments)
    assert info.duration > 0
    if args.audio:
        assert "speech" in text.lower() and "test" in text.lower(), text
print(json.dumps({"ok": True, "source": "modelscope", "model": args.model,
                  "directory": str(expected), "networkBlocked": True, "duration": info.duration, "text": text}, ensure_ascii=False))
