"""POST /listen: Whisper's text -> wake word -> answer. No model or API calls: stt and ask are faked."""
import asyncio
import io
import sys
import wave
from pathlib import Path
from unittest.mock import AsyncMock

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import main  # noqa: E402
import stt  # noqa: E402


@pytest.mark.parametrize("text, woke, question", [
    ("Hey Jarvis, where did I leave my helmet?", True, "where did I leave my helmet"),
    ("Where are my keys, Jarvis?", True, "Where are my keys"),
    ("Jarvis.", True, ""),
    ("OK Jervis what room am I in", True, "what room am I in"),
    ("nice costume", False, "nice costume"),
])
def test_split_wake(text, woke, question):
    assert main.split_wake(text) == (woke, question)


class Upload:
    def __init__(self, data=b"RIFF"):
        self.data = data

    async def read(self):
        return self.data


def run_listen(monkeypatch, heard, mode):
    monkeypatch.setattr(stt, "transcribe", lambda data: heard)
    asked = AsyncMock(return_value={"answer": "On the chair, sir.", "kind": "find", "frames": []})
    monkeypatch.setattr(main, "ask", asked)
    return asyncio.run(main.listen(audio=Upload(), mode=mode)), asked


def test_wake_mode_answers_after_jarvis(monkeypatch):
    reply, asked = run_listen(monkeypatch, "Hey Jarvis, where's my helmet?", "wake")
    assert reply["question"] == "where's my helmet"
    assert reply["result"]["answer"] == "On the chair, sir."
    assert asked.await_args.args[0].question == "where's my helmet"


def test_wake_mode_ignores_chatter(monkeypatch):
    reply, asked = run_listen(monkeypatch, "great costume by the way", "wake")
    assert reply == {"heard": "great costume by the way", "question": None, "armed": False, "result": None}
    asked.assert_not_awaited()


def test_jarvis_alone_arms(monkeypatch):
    reply, asked = run_listen(monkeypatch, "Jarvis?", "wake")
    assert reply["armed"] is True and reply["result"] is None
    asked.assert_not_awaited()


def test_ask_mode_takes_everything(monkeypatch):
    reply, asked = run_listen(monkeypatch, "what room am I in", "ask")
    assert reply["question"] == "what room am I in"
    asked.assert_awaited_once()


def test_silence_does_nothing(monkeypatch):
    reply, asked = run_listen(monkeypatch, "", "ask")
    assert reply["question"] is None and reply["result"] is None
    asked.assert_not_awaited()


def _wav(samples: np.ndarray, rate: int, channels: int = 1) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes((samples * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def test_decode_wav_resamples_and_mixes_down():
    stereo_48k = np.zeros(48000 * 2, dtype=np.float32)  # 1 s of stereo at 48 kHz
    out = stt.decode_wav(_wav(stereo_48k, 48000, channels=2))
    assert out.dtype == np.float32 and len(out) == 16000


def test_decode_wav_rejects_non_wav():
    with pytest.raises(ValueError):
        stt.decode_wav(b"not audio")


def test_too_short_is_empty_without_loading_the_model(monkeypatch):
    monkeypatch.setattr(stt, "_load", lambda: pytest.fail("model should not load"))
    assert stt.transcribe(_wav(np.zeros(1600, dtype=np.float32), 16000)) == ""
