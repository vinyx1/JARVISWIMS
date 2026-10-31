"""Unit tests for backend/voice.py. Owner: Paul (D). No network: ElevenLabs is faked.

Run from the repo root:
    backend/.venv/bin/python -m pytest tests/ -q
"""
import json
import sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import voice  # noqa: E402

MP3 = b"ID3fake-mp3-bytes"


def fake_client(status=200, content=MP3, content_type="audio/mpeg", error=None):
    """An httpx.Client whose requests never leave the machine; records what was sent."""
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if error:
            raise error
        return httpx.Response(status, content=content, headers={"content-type": content_type})

    return httpx.Client(transport=httpx.MockTransport(handler)), sent


@pytest.fixture(autouse=True)
def eleven_env(monkeypatch):
    voice.clear_cache()
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    monkeypatch.delenv("ELEVENLABS_VOICE_ID", raising=False)
    monkeypatch.delenv("ELEVENLABS_MODEL", raising=False)


def test_returns_mp3_and_calls_jarvis_voice():
    client, sent = fake_client()
    audio = voice.synthesize("Your helmet is on the grey chair, sir.", client=client)
    assert audio == MP3
    req = sent[0]
    assert req.method == "POST"
    assert req.url.path == f"/v1/text-to-speech/{voice.DEFAULT_VOICE_ID}"
    assert req.url.params["output_format"] == voice.OUTPUT_FORMAT
    assert req.headers["xi-api-key"] == "test-key"
    body = json.loads(req.content)
    assert body["text"] == "Your helmet is on the grey chair, sir."
    assert body["model_id"] == voice.DEFAULT_MODEL
    # variant C (picked by ear): expressive, slightly slower, a little dramatic
    assert body["voice_settings"] == {"stability": 0.2, "similarity_boost": 0.75, "style": 0.75,
                                      "use_speaker_boost": True, "speed": 0.92}


def test_voice_and_model_can_be_overridden_by_env(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_VOICE_ID", "other-voice")
    monkeypatch.setenv("ELEVENLABS_MODEL", "eleven_flash_v2_5")
    client, sent = fake_client()
    voice.synthesize("Very good, sir.", client=client)
    assert sent[0].url.path == "/v1/text-to-speech/other-voice"
    assert json.loads(sent[0].content)["model_id"] == "eleven_flash_v2_5"


def test_long_text_is_trimmed():
    client, sent = fake_client()
    voice.synthesize("word " * 500, client=client)
    assert len(json.loads(sent[0].content)["text"]) <= voice.MAX_CHARS


@pytest.mark.parametrize("text", ["", "   ", None])
def test_empty_text_makes_no_request(text):
    client, sent = fake_client()
    assert voice.synthesize(text, client=client) is None
    assert sent == []


def test_missing_key_makes_no_request(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY")
    client, sent = fake_client()
    assert voice.synthesize("Sir?", client=client) is None
    assert sent == []


@pytest.mark.parametrize("status, content_type", [(401, "application/json"), (429, "application/json"),
                                                  (500, "text/plain"), (200, "application/json")])
def test_bad_responses_return_none(status, content_type):
    client, _ = fake_client(status=status, content=b'{"detail": "nope"}', content_type=content_type)
    assert voice.synthesize("Sir?", client=client) is None


def test_network_error_returns_none():
    client, _ = fake_client(error=httpx.ConnectError("wifi down"))
    assert voice.synthesize("Sir?", client=client) is None


def test_timeout_returns_none():
    client, _ = fake_client(error=httpx.ReadTimeout("slow"))
    assert voice.synthesize("Sir?", client=client) is None


def test_same_line_is_cached_so_repeated_fillers_cost_one_request():
    voice.clear_cache()
    client, sent = fake_client()
    assert voice.synthesize("One moment, sir.", client=client) == MP3
    assert voice.synthesize("One moment, sir.", client=client) == MP3
    assert len(sent) == 1


def test_rate_limit_is_retried_once():
    voice.clear_cache()
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, content=b'{"detail":"concurrent_limit_exceeded"}',
                                  headers={"content-type": "application/json"})
        return httpx.Response(200, content=MP3, headers={"content-type": "audio/mpeg"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert voice.synthesize("Sir?", client=client) == MP3
    assert len(calls) == 2


def test_gives_up_instead_of_queuing_forever_when_all_slots_are_busy(monkeypatch):
    voice.clear_cache()
    monkeypatch.setattr(voice, "SLOT_WAIT_S", 0.05)
    held = [voice._slots.acquire() for _ in range(voice.MAX_CONCURRENT)]
    try:
        client, sent = fake_client()
        assert voice.synthesize("Sir?", client=client) is None   # the HUD falls back; no thread stuck
        assert sent == []
    finally:
        for _ in held:
            voice._slots.release()
