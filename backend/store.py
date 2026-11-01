"""Frame + caption storage. Owner: Vince (B).

JPEGs go in data/frames/. The log is kept in memory and written to data/log.json
whenever it changes, so captions can be filled in after a frame is saved.
"""
import json
import os
import shutil
import threading
from pathlib import Path

# JARVIS_DATA lets a test server (scripts/smoke.py) use its own folder instead of the demo's.
DATA = Path(os.environ.get("JARVIS_DATA") or Path(__file__).resolve().parent.parent / "data")
FRAMES = DATA / "frames"
LOG = DATA / "log.json"
MINE = DATA / "mine.json"
FRAMES.mkdir(parents=True, exist_ok=True)

_lock = threading.Lock()
_log: list[dict] = json.loads(LOG.read_text()) if LOG.exists() else []
_mine: list[dict] = json.loads(MINE.read_text()) if MINE.exists() else []
# Bumped by reset(). Frame ids restart at f_000000 after a reset, so a caption still running
# from the previous run must not land on the new frame that reuses its id.
_session = 0


def session() -> int:
    return _session


def _persist() -> None:
    LOG.write_text(json.dumps(_log))
    MINE.write_text(json.dumps(_mine))


def add_frame(jpeg: bytes, ts: float) -> dict:
    """Save a frame immediately, with caption=None until it's captioned."""
    with _lock:
        frame_id = f"f_{len(_log):06d}"
        (FRAMES / f"{frame_id}.jpg").write_bytes(jpeg)
        entry = {"id": frame_id, "ts": ts, "url": f"/frames/{frame_id}.jpg", "caption": None}
        _log.append(entry)
        _persist()
        return dict(entry)


def set_caption(frame_id: str, caption: dict, session_id: int | None = None) -> None:
    with _lock:
        if session_id is not None and session_id != _session:
            return  # captioned before a reset: that frame is gone
        for e in reversed(_log):
            if e["id"] == frame_id:
                e["caption"] = caption
                break
        _persist()


def read_log() -> list[dict]:
    with _lock:
        return [dict(e) for e in _log]


def latest() -> dict | None:
    with _lock:
        return dict(_log[-1]) if _log else None


def remember(item: str, description: str, frame: dict) -> dict:
    """Register one of sir's own items. Re-registering the same item replaces it."""
    with _lock:
        _mine[:] = [m for m in _mine if m["item"] != item]
        entry = {"item": item, "description": description, "frame_id": frame["id"],
                 "url": frame["url"], "ts": frame["ts"]}
        _mine.append(entry)
        _persist()
        return dict(entry)


def mine() -> list[dict]:
    with _lock:
        return [dict(m) for m in _mine]


def reset() -> None:
    global _session
    with _lock:
        _session += 1
        _log.clear()
        _mine.clear()
        shutil.rmtree(FRAMES, ignore_errors=True)
        FRAMES.mkdir(parents=True, exist_ok=True)
        _persist()
