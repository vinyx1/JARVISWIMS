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


def test_last_seen_record_is_kept_and_only_moves_forward(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_DATA", str(tmp_path))
    import store
    store = importlib.reload(store)
    try:
        a = store.add_frame(b"\xff\xd8a", 1000.0)
        b = store.add_frame(b"\xff\xd8b", 2000.0)
        store.remember("airpods", "white AirPods Pro case", a)
        assert store.mark_seen("AirPods", b["id"], "on desk by the window", "workspace", ["window"])
        assert not store.mark_seen("airpods", a["id"], "older spot")       # older frame: ignored
        assert not store.mark_seen("keys", b["id"], "on desk")             # not registered
        seen = store.mine()[0]["last_seen"]
        assert seen["where"] == "on desk by the window" and seen["frame_id"] == b["id"] and seen["ts"] == 2000.0
    finally:
        monkeypatch.delenv("JARVIS_DATA")
        importlib.reload(store)


def test_remember_keeps_marks_and_closeup_and_reset_clears_them(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_DATA", str(tmp_path))
    import store
    store = importlib.reload(store)
    try:
        f = store.add_frame(b"\xff\xd8a", 1.0)
        entry = store.remember("Blue Mug", "blue mug with a chipped rim", f, ["chipped rim", "white handle"], b"\xff\xd8closeup")
        assert entry["marks"] == ["chipped rim", "white handle"]
        assert store.ref_path(entry).read_bytes() == b"\xff\xd8closeup"
        assert store.ref_path(entry).name == "blue-mug.jpg"
        store.reset()
        assert store.ref_path(entry) is None
    finally:
        monkeypatch.delenv("JARVIS_DATA")
        importlib.reload(store)
