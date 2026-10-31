"""Frame + caption storage. Owner: Person B.

JPEGs go in data/frames/, and the captions go in data/log.jsonl (one LogEntry per line).
"""
import json
import shutil
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
FRAMES = DATA / "frames"
LOG = DATA / "log.jsonl"
FRAMES.mkdir(parents=True, exist_ok=True)


def next_id() -> str:
    n = sum(1 for _ in LOG.open()) if LOG.exists() else 0
    return f"f_{n:06d}"


def save_frame(frame_id: str, jpeg: bytes) -> str:
    (FRAMES / f"{frame_id}.jpg").write_bytes(jpeg)
    return f"/frames/{frame_id}.jpg"


def append(entry: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def read_log() -> list[dict]:
    if not LOG.exists():
        return []
    return [json.loads(line) for line in LOG.open() if line.strip()]


def reset() -> None:
    shutil.rmtree(DATA, ignore_errors=True)
    FRAMES.mkdir(parents=True, exist_ok=True)
