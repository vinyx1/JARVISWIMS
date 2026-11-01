"""store.py: a caption that finishes after a reset must not land on the new run's frame."""
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))


def test_stale_caption_after_reset_is_dropped(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_DATA", str(tmp_path))
    import store
    store = importlib.reload(store)
    try:
        old = store.add_frame(b"\xff\xd8old", 1.0)
        old_session = store.session()
        store.reset()
        new = store.add_frame(b"\xff\xd8new", 2.0)
        assert new["id"] == old["id"]  # ids restart after a reset
        store.set_caption(old["id"], {"scene": "stale"}, old_session)
        assert store.latest()["caption"] is None
        store.set_caption(new["id"], {"scene": "fresh"}, store.session())
        assert store.latest()["caption"] == {"scene": "fresh"}
        assert (tmp_path / "frames" / f"{new['id']}.jpg").exists()
    finally:
        monkeypatch.delenv("JARVIS_DATA")
        importlib.reload(store)
