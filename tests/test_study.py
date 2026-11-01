"""ai.study_item / crop / reference blocks. No API calls (stub mode or pure functions)."""
import io
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import ai  # noqa: E402


def _jpeg(w=1920, h=1080):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (40, 80, 160)).save(buf, "JPEG")
    return buf.getvalue()


def test_crop_is_a_padded_closeup_of_the_box():
    out = Image.open(io.BytesIO(ai.crop(_jpeg(), [0.4, 0.4, 0.5, 0.5], pad=0.2)))
    # 192x108 box, padded 20% each side -> ~269x151
    assert 260 <= out.width <= 275 and 145 <= out.height <= 155


def test_crop_keeps_a_minimum_size_for_tiny_items():
    out = Image.open(io.BytesIO(ai.crop(_jpeg(), [0.5, 0.5, 0.505, 0.505], pad=0.2, min_side=96)))
    assert out.width >= 95 and out.height >= 95


def test_study_item_stub_returns_marks_and_closeup(monkeypatch):
    monkeypatch.setenv("ECHO_STUB_AI", "1")
    study = ai.study_item(_jpeg(), "mug")
    assert study["marks"] and study["box"] and study["closeup"][:2] == b"\xff\xd8"


def test_strip_location():
    assert ai._strip_location("white AirPods case on the desk by the window") == "white AirPods case"


def test_caption_reference_uses_closeup_and_marks(tmp_path, monkeypatch):
    import importlib
    monkeypatch.setenv("JARVIS_DATA", str(tmp_path))
    import store
    store = importlib.reload(store)
    try:
        f = store.add_frame(_jpeg(), 1.0)
        entry = store.remember("mug", "blue mug with a chipped rim", f, ["chipped rim"], _jpeg(200, 200))
        blocks = ai._mine_blocks([entry])
        texts = " ".join(b.get("text", "") for b in blocks)
        assert "distinguishing marks: chipped rim" in texts and "Close-up of it" in texts
        assert any(b["type"] == "image" for b in blocks)
    finally:
        monkeypatch.delenv("JARVIS_DATA")
        importlib.reload(store)


def test_marks_about_surroundings_are_dropped(monkeypatch):
    from types import SimpleNamespace
    parsed = ai.Studied(visible=True, description="white AirPods case", marks=["scratch on lid", "black pouch beside it", "lying on the desk"],
                        x0=10, y0=10, x1=100, y1=100)
    fake = SimpleNamespace(messages=SimpleNamespace(parse=lambda **k: SimpleNamespace(parsed_output=parsed, stop_reason="end_turn")))
    monkeypatch.setattr(ai, "_client_", lambda: fake)
    monkeypatch.delenv("ECHO_STUB_AI", raising=False)
    assert ai.study_item(_jpeg(), "airpods")["marks"] == ["scratch on lid"]
