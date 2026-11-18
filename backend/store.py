"""Frame + caption storage, one "room" per visitor. Owner: Vince (B).

A room is one person's Jarvis: their frames, registered items and live state (preview, the
latest answer, ...). Locally (./start) there is one room, "local", stored straight in data/ as
before, so the laptop HUD and the phone share it. On a public deployment (JARVIS_PUBLIC=1)
every visitor gets their own room under data/rooms/<id>/, picked by a cookie in main.py.

The module-level functions (add_frame, read_log, mine, ...) act on the *current* room, a
ContextVar that main.py sets per request; code that runs outside a request (tests, scripts)
gets the local room. `store.FRAMES` / `store.REFS` resolve to the current room's folders too.

JPEGs go in <room>/frames/. The log is kept in memory and written to <room>/log.json whenever
it changes, so captions can be filled in after a frame is saved.
"""
import contextvars
import json
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

# JARVIS_DATA lets a test server (scripts/smoke.py) use its own folder instead of the demo's.
DATA = Path(os.environ.get("JARVIS_DATA") or Path(__file__).resolve().parent.parent / "data")
ROOMS = DATA / "rooms"

PUBLIC = os.getenv("JARVIS_PUBLIC", "") == "1"
# Per-room caps (0 = unlimited, the local default). Public: ~20 min of walking, a dozen items.
MAX_FRAMES = int(os.getenv("JARVIS_MAX_FRAMES", "400" if PUBLIC else "0"))
MAX_ITEMS = int(os.getenv("JARVIS_MAX_ITEMS", "12" if PUBLIC else "0"))
MAX_ROOMS = int(os.getenv("JARVIS_MAX_ROOMS", "40"))      # public rooms alive at once
ROOM_TTL_S = float(os.getenv("JARVIS_ROOM_TTL_MIN", "60")) * 60   # idle public rooms are deleted
EMPTY_TTL_S = min(ROOM_TTL_S, 600)   # a room that never got a photo or an item goes sooner

_ROOM_ID = re.compile(r"^[A-Za-z0-9_-]{20,64}$")


class Full(Exception):
    """A per-room limit was reached (frames or items). The message is safe to show."""


class Room:
    def __init__(self, room_id: str, folder: Path):
        self.id = room_id
        self.dir = folder
        self.frames = folder / "frames"
        self.refs = folder / "refs"       # close-ups of sir's registered items, one per item
        self.log_file = folder / "log.json"
        self.mine_file = folder / "mine.json"
        self.frames.mkdir(parents=True, exist_ok=True)
        self.refs.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.log: list[dict] = _load(self.log_file)
        self.mine: list[dict] = _load(self.mine_file)
        # Bumped by reset(). Frame ids restart at f_000000 after a reset, so a caption still running
        # from the previous run must not land on the new frame that reuses its id.
        self.session = 0
        self.last_used = time.time()
        # Live state that main.py keeps per room (never written to disk).
        self.preview: dict = {"jpeg": None, "ts": 0.0, "client_ts": 0.0}
        self.still: dict = {"jpeg": None, "ts": 0.0}
        self.activity: dict = {"id": 0, "state": "idle", "question": None, "ts": 0.0}
        self.exchange: dict | None = None
        self.exchange_generation = 0
        self.ask_inflight = 0
        self.interaction_lock = threading.Lock()
        self.watching: dict[str, float] = {}   # item -> since (ms)
        self.watch_lock = threading.Lock()

    def persist(self) -> None:
        self.log_file.write_text(json.dumps(self.log))
        self.mine_file.write_text(json.dumps(self.mine))


def _load(path: Path) -> list:
    try:
        return json.loads(path.read_text()) if path.exists() else []
    except (OSError, ValueError):
        return []


_local = Room("local", DATA)
_rooms: dict[str, Room] = {}
_rooms_lock = threading.Lock()
_current: contextvars.ContextVar[Room] = contextvars.ContextVar("jarvis_room", default=_local)


def current() -> Room:
    return _current.get()


def use(room: Room) -> contextvars.Token:
    """Make `room` the current room for this request (and threads started with its context)."""
    room.last_used = time.time()
    return _current.set(room)


def reset_current(token: contextvars.Token) -> None:
    _current.reset(token)


def new_room_id() -> str:
    return secrets.token_urlsafe(24)


def valid_room_id(room_id: str | None) -> bool:
    return bool(room_id) and bool(_ROOM_ID.match(room_id))


def get_room(room_id: str, create: bool = False) -> Room | None:
    """The public room with this id; with create=True, made if it doesn't exist yet. None when the
    id is malformed, or creating it would pass MAX_ROOMS (after evicting expired rooms)."""
    if not valid_room_id(room_id):
        return None
    with _rooms_lock:
        room = _rooms.get(room_id)
        if room:
            return room
        folder = ROOMS / room_id
        if not create and not folder.is_dir():
            return None
        _evict_expired_locked()
        if len(_rooms) >= MAX_ROOMS:
            return None
        room = _rooms[room_id] = Room(room_id, folder)
        return room


def room_count() -> int:
    with _rooms_lock:
        return len(_rooms)


def evict_expired() -> int:
    with _rooms_lock:
        return _evict_expired_locked()


def _evict_expired_locked() -> int:
    """Delete public rooms nobody has used for ROOM_TTL_S (memory and disk). Also clears folders
    left on disk by an earlier server process."""
    now, gone = time.time(), 0
    for room_id, room in list(_rooms.items()):
        if now - room.last_used > (ROOM_TTL_S if room.log or room.mine else EMPTY_TTL_S):
            del _rooms[room_id]
            shutil.rmtree(room.dir, ignore_errors=True)
            gone += 1
    if ROOMS.is_dir():
        for folder in ROOMS.iterdir():
            if folder.name not in _rooms:
                try:
                    if now - folder.stat().st_mtime > ROOM_TTL_S:
                        shutil.rmtree(folder, ignore_errors=True)
                except OSError:
                    pass
    return gone


def __getattr__(name: str):
    """store.FRAMES / store.REFS / store.LOG / store.MINE: the current room's paths."""
    room = _current.get()
    paths = {"FRAMES": room.frames, "REFS": room.refs, "LOG": room.log_file, "MINE": room.mine_file}
    if name in paths:
        return paths[name]
    raise AttributeError(f"module 'store' has no attribute {name!r}")


# ---------- the current room's data ----------

def session() -> int:
    return current().session


def frame_path(frame_id: str) -> Path | None:
    """The current room's JPEG for a frame id like f_000012, or None."""
    if not re.fullmatch(r"f_\d{6,}", frame_id or ""):
        return None
    path = current().frames / f"{frame_id}.jpg"
    return path if path.is_file() else None


def add_frame(jpeg: bytes, ts: float) -> dict:
    """Save a frame immediately, with caption=None until it's captioned. Raises Full past MAX_FRAMES."""
    room = current()
    with room.lock:
        if MAX_FRAMES and len(room.log) >= MAX_FRAMES:
            raise Full(f"My memory is full, sir ({MAX_FRAMES} photos). Clear it to keep going.")
        frame_id = f"f_{len(room.log):06d}"
        (room.frames / f"{frame_id}.jpg").write_bytes(jpeg)
        entry = {"id": frame_id, "ts": ts, "url": f"/frames/{frame_id}.jpg", "caption": None}
        room.log.append(entry)
        room.persist()
        return dict(entry)


def set_caption(frame_id: str, caption: dict, session_id: int | None = None) -> None:
    room = current()
    with room.lock:
        if session_id is not None and session_id != room.session:
            return  # captioned before a reset: that frame is gone
        for e in reversed(room.log):
            if e["id"] == frame_id:
                e["caption"] = caption
                break
        room.persist()


def read_log() -> list[dict]:
    room = current()
    with room.lock:
        return [dict(e) for e in room.log]


def latest() -> dict | None:
    room = current()
    with room.lock:
        return dict(room.log[-1]) if room.log else None


def ref_path(entry: dict) -> Path | None:
    """The registered item's close-up reference photo, if one was saved."""
    name = entry.get("ref")
    path = current().refs / name if name else None
    return path if path and path.is_file() else None


def remember(item: str, description: str, frame: dict, marks: list[str] = (), closeup: bytes | None = None) -> dict:
    """Register one of sir's own items. Re-registering the same item replaces it.
    Raises Full past MAX_ITEMS.

    closeup: a cropped, full-resolution photo of just the item, used to recognise it later."""
    room = current()
    with room.lock:
        others = [m for m in room.mine if m["item"] != item]
        if MAX_ITEMS and len(others) >= MAX_ITEMS:
            raise Full(f"I can only keep track of {MAX_ITEMS} things at once, sir.")
        room.mine[:] = others
        entry = {"item": item, "description": description, "frame_id": frame["id"],
                 "url": frame["url"], "ts": frame["ts"], "marks": list(marks)}
        if closeup:
            name = re.sub(r"[^a-z0-9]+", "-", item.lower()).strip("-") + ".jpg"
            (room.refs / name).write_bytes(closeup)
            entry["ref"] = name
        room.mine.append(entry)
        room.persist()
        return dict(entry)


def mark_seen(item: str, frame_id: str, where: str, room: str = "", landmarks: list[str] = (),
              force: bool = False) -> bool:
    """Record where one of sir's registered items was last seen. Never expires, unlike the
    caption window answers look at. Ignores a frame older than the current record, unless
    `force` (sir pointed at that photo himself: "that's it")."""
    r = current()
    with r.lock:
        frame = next((e for e in reversed(r.log) if e["id"] == frame_id), None)
        entry = next((m for m in r.mine if m["item"].lower() == item.lower()), None)
        if not frame or not entry:
            return False
        old = entry.get("last_seen")
        if old and old.get("ts", 0) > frame["ts"] and not force:
            return False
        entry["last_seen"] = {"frame_id": frame_id, "url": frame["url"], "ts": frame["ts"],
                              "where": where, "room": room, "landmarks": list(landmarks)[:3]}
        r.persist()
        return True


def mine() -> list[dict]:
    room = current()
    with room.lock:
        return [dict(m) for m in room.mine]


def reset() -> None:
    room = current()
    with room.lock:
        room.session += 1
        room.log.clear()
        room.mine.clear()
        shutil.rmtree(room.frames, ignore_errors=True)
        room.frames.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(room.refs, ignore_errors=True)
        room.refs.mkdir(parents=True, exist_ok=True)
        room.persist()
