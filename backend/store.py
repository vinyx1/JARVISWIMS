"""Frame + caption storage. Owner: Vince (B).

JPEGs go in data/frames/. The log is kept in memory and written to data/log.json
whenever it changes, so captions can be filled in after a frame is saved.
"""
import json
import shutil
import threading
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
FRAMES = DATA / "frames"
LOG = DATA / "log.json"
FRAMES.mkdir(parents=True, exist_ok=True)

_lock = threading.Lock()
_log: list[dict] = json.loads(LOG.read_text()) if LOG.exists() else []


def _persist() -> None:
    LOG.write_text(json.dumps(_log))


def add_frame(jpeg: bytes, ts: float) -> dict:
    """Save a frame immediately, with caption=None until it's captioned."""
    with _lock:
        frame_id = f"f_{len(_log):06d}"
        (FRAMES / f"{frame_id}.jpg").write_bytes(jpeg)
        entry = {"id": frame_id, "ts": ts, "url": f"/frames/{frame_id}.jpg", "caption": None}
        _log.append(entry)
        _persist()
        return dict(entry)


def set_caption(frame_id: str, caption: dict) -> None:
    with _lock:
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


def reset() -> None:
    with _lock:
        _log.clear()
        shutil.rmtree(FRAMES, ignore_errors=True)
        FRAMES.mkdir(parents=True, exist_ok=True)
        _persist()
