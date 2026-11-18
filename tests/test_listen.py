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

    async def read(self, size=-1):
        return self.data if size < 0 else self.data[:size]


def run_listen(monkeypatch, heard, mode, **extra):
    monkeypatch.setattr(stt, "transcribe", lambda data: heard)
    asked = AsyncMock(return_value={"answer": "On the chair, sir.", "kind": "find", "frames": []})
    monkeypatch.setattr(main, "ask", asked)
    return asyncio.run(main.listen(audio=Upload(), mode=mode, **extra)), asked


def test_wake_mode_answers_after_jarvis(monkeypatch):
    reply, asked = run_listen(monkeypatch, "Hey Jarvis, where's my helmet?", "wake")
    assert reply["question"] == "where's my helmet"
    assert reply["result"]["answer"] == "On the chair, sir."
    assert asked.await_args.args[0].question == "where's my helmet"


def test_wake_mode_ignores_chatter(monkeypatch):
    reply, asked = run_listen(monkeypatch, "great costume by the way", "wake")
    assert reply == {"heard": "great costume by the way", "question": None, "armed": False, "result": None, "need_still": False}
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


@pytest.mark.parametrize("text, item", [
    ("Jarvis, I'm leaving my AirPods here", "airpods"),
    ("I put my keys here", "keys"),
    ("my AirPods are right here", "airpods"),
    ("putting my helmet down here", "helmet"),
    ("remember where I put my black water bottle", "black water bottle"),
    ("Jarvis, where are my AirPods?", None),
    ("this is my laptop, remember it", None),
])
def test_place_item(text, item):
    assert main.place_item(text) == item


def test_where_from_caption_prefers_the_my_tag_then_the_item_then_the_scene():
    cap = {"scene": "A desk by the window.", "objects": ["MY airpods (white AirPods case) on desk by the window"]}
    assert main._where_from_caption("airpods", cap) == "on desk by the window"
    cap = {"scene": "A desk.", "objects": ["white airpods case on the desk next to a mug"]}
    assert main._where_from_caption("airpods", cap) == "on the desk next to a mug"
    assert main._where_from_caption("airpods", {"scene": "A cluttered desk.", "objects": []}) == "here (a cluttered desk)"


@pytest.mark.parametrize("text, item", [
    ("Jarvis, this is my laptop, remember it", "laptop"),
    ("Jarvis, these are my AirPods, remember them", "airpods"),
    ("those are my keys", "keys"),
    ("they're my glasses, remember them", "glasses"),
    ("these keys are mine", "keys"),
    ("remember these headphones", "headphones"),
    ("where are my AirPods?", None),
])
def test_remember_item_singular_and_plural(text, item):
    assert main.remember_item(text) == item


def test_remember_from_a_camera_device_asks_for_a_photo_first(monkeypatch):
    reply, asked = run_listen(monkeypatch, "Jarvis, this is my mug, remember it", "wake", can_send_still=True)
    assert reply["need_still"] is True and reply["result"] is None
    assert reply["question"] == "this is my mug, remember it"
    asked.assert_not_awaited()


def test_ordinary_questions_never_ask_for_a_photo(monkeypatch):
    reply, asked = run_listen(monkeypatch, "Jarvis, where is my mug?", "wake", can_send_still=True)
    assert reply["need_still"] is False and reply["result"] is not None


def test_devices_without_a_camera_register_straight_away(monkeypatch):
    reply, asked = run_listen(monkeypatch, "Jarvis, this is my mug, remember it", "wake")
    assert reply["need_still"] is False
    asked.assert_awaited_once()


def test_a_still_is_used_once_and_only_while_fresh(monkeypatch, tmp_path):
    import time as _time
    monkeypatch.setattr(main.store, "add_frame", lambda jpeg, ts: {"id": "f_000001", "jpeg": jpeg})
    main._preview.update(jpeg=b"preview", ts=_time.time())
    main._still.update(jpeg=b"still", ts=_time.time())
    assert main._current_view(caption=False)["jpeg"] == b"still"
    assert main._current_view(caption=False)["jpeg"] == b"preview"     # consumed: not reused
    main._still.update(jpeg=b"old still", ts=_time.time() - 30)
    assert main._current_view(caption=False)["jpeg"] == b"preview"     # stale: ignored
    main._preview.update(jpeg=None, ts=0.0); main._still.update(jpeg=None, ts=0.0)


def test_activity_follows_the_conversation(monkeypatch):
    main._set_activity("idle")
    monkeypatch.setattr(main, "_answer_request", AsyncMock(return_value={"answer": "x", "kind": "other", "frames": []}))
    asyncio.run(main.ask(main.Ask(question="where is my helmet")))     # the real ask()
    a = main.activity()
    assert a["state"] == "answered" and a["question"] == "where is my helmet"
    run_listen(monkeypatch, "Jarvis?", "wake")
    assert main.activity()["state"] == "armed"
    main._activity["ts"] -= 100
    assert main.activity()["state"] == "idle"   # "armed" expires


def test_answers_remember_which_device_asked(monkeypatch):
    monkeypatch.setattr(main, "_answer_request", AsyncMock(return_value={"answer": "x", "kind": "other", "frames": []}))
    asyncio.run(main.ask(main.Ask(question="where is my mug", source="phone-123")))
    assert main.interaction()["source"] == "phone-123"
    asyncio.run(main.ask(main.Ask(question="typed on the laptop")))
    assert main.interaction()["source"] is None


def test_spoken_questions_carry_the_device_id(monkeypatch):
    monkeypatch.setattr(stt, "transcribe", lambda data: "Jarvis, where is my mug?")
    seen = {}
    async def fake_ask(body):
        seen["source"] = body.source
        return {"answer": "x", "kind": "other", "frames": []}
    monkeypatch.setattr(main, "ask", fake_ask)
    asyncio.run(main.listen(audio=Upload(), mode="wake", source="phone-abc"))
    assert seen["source"] == "phone-abc"


def test_transcribe_only_returns_the_question_without_answering(monkeypatch):
    reply, asked = run_listen(monkeypatch, "Jarvis, where is my mug?", "wake", answer=False)
    assert reply["question"] == "where is my mug" and reply["result"] is None
    asked.assert_not_awaited()
    assert main.activity()["state"] == "thinking"   # the HUD already shows him thinking
