"""Railway has no macOS `say`: /speak falls back to Piper, so Jarvis isn't silent on Linux."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import main  # noqa: E402
import piper_voice  # noqa: E402


def test_speak_uses_piper_without_say(monkeypatch):
    monkeypatch.setattr(main.voice, "synthesize", lambda text: None)       # no ElevenLabs key
    monkeypatch.setattr(main, "_say_wav", lambda text: None)               # Linux: no `say`
    monkeypatch.setattr(piper_voice, "synthesize", lambda text: b"RIFFpiper")
    r = asyncio.run(main.speak(main.Speak(text="Very good, sir.")))
    assert r.status_code == 200 and r.media_type == "audio/wav" and r.body == b"RIFFpiper"


def test_no_voice_at_all_is_a_204(monkeypatch):
    monkeypatch.setattr(main.voice, "synthesize", lambda text: None)
    monkeypatch.setattr(main, "_say_wav", lambda text: None)
    monkeypatch.setattr(piper_voice, "synthesize", lambda text: None)
    assert asyncio.run(main.speak(main.Speak(text="Sir?"))).status_code == 204


def test_missing_voice_file_means_unavailable(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_PIPER_VOICE", str(tmp_path / "nope.onnx"))
    assert piper_voice.model_path() is None and not piper_voice.available()
