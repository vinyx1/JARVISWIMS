"""FastAPI app. Owner: Vince (B). Implements the contract in API.md.

Two ways to run it:
- Locally (./start): one shared room for the laptop HUD and the phone; the tunnel is locked
  with a per-run access key (JARVIS_ACCESS_KEY).
- Public (JARVIS_PUBLIC=1, e.g. on Railway): every visitor gets a private room (their own
  photos, items and answers), picked by a cookie. Rate limits, upload caps, room limits and a
  daily AI budget (budget.py) keep strangers from running up the bill or knocking it over.
See "Security" below and DEPLOY.md.
"""
import asyncio
import contextvars
import logging
import math
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import ai  # noqa: E402
import answer  # noqa: E402
import budget  # noqa: E402  (daily spending cap on Claude calls)
import store  # noqa: E402
import stt  # noqa: E402  (local Whisper: speech to text)
import voice  # noqa: E402  (Paul's ElevenLabs wrapper)

log = logging.getLogger("uvicorn.error")
PUBLIC = os.getenv("JARVIS_PUBLIC", "") == "1"
# Public: no interactive API docs (they'd list every endpoint for anyone poking around).
app = FastAPI(title="jarvis", **({"docs_url": None, "redoc_url": None, "openapi_url": None} if PUBLIC else {}))
ASK_TIMEOUT_S = float(os.getenv("ASK_TIMEOUT_S", "12"))

# ======================================== Security ========================================
# Size caps on everything a visitor can send (enforced on every deployment).
MAX_BODY_BYTES = 6 * 1024 * 1024        # whole request: audio + a sharp still fit with room to spare
MAX_IMAGE_BYTES = 3 * 1024 * 1024       # a 1920px still at q=0.88 is ~0.5-1 MB
MAX_PREVIEW_BYTES = 400 * 1024          # live preview frames are ~20-60 KB
MAX_AUDIO_BYTES = 1024 * 1024           # 16 kHz mono 16-bit WAV: ~32 s
MAX_QUESTION_CHARS = 400
_ears = asyncio.Semaphore(int(os.getenv("JARVIS_STT_CONCURRENCY", "2")))


async def _read_upload(upload: UploadFile, limit: int) -> bytes:
    data = await upload.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=413, detail="That file is too large, sir.")
    return data


async def _read_image(upload: UploadFile, limit: int) -> bytes:
    """A JPEG or PNG under `limit` bytes; anything else is refused (we only ever serve it back as an image)."""
    data = await _read_upload(upload, limit)
    if not (data.startswith(b"\xff\xd8") or data.startswith(b"\x89PNG\r\n\x1a\n")):
        raise HTTPException(status_code=415, detail="Only JPEG or PNG photos, sir.")
    return data


class Limiter:
    """Token buckets in memory: allow(key, per_s, burst). One process, so no Redis needed."""

    def __init__(self):
        self._buckets: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, per_s: float, burst: float) -> bool:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(key, (burst, now))
            tokens = min(burst, tokens + (now - last) * per_s)
            ok = tokens >= 1
            self._buckets[key] = [tokens - 1 if ok else tokens, now]
            return ok

    def prune(self, idle_s: float = 3600) -> None:
        cutoff = time.monotonic() - idle_s
        with self._lock:
            for key in [k for k, (_, last) in self._buckets.items() if last < cutoff]:
                del self._buckets[key]


limiter = Limiter()
RATE_LIMITS = PUBLIC or os.getenv("JARVIS_RATE_LIMIT", "") == "1"
PER_IP = (60.0, 150)             # any request, per client IP: the HUD + phone poll ~35/s together
NEW_ROOMS_PER_IP = (10 / 3600, 10)   # rooms created per IP: 10 at once, then 10 an hour
# Per room (visitor), per endpoint: (per second, burst). Generous for real use, tight on cost.
ROUTE_LIMITS = {
    "/frame": (30 / 60, 10),     # each one is a caption call; the phone sends one every ~3 s
    "/preview": (20.0, 40),      # live preview ~15 fps, no AI
    "/still": (20 / 60, 6),
    "/ask": (12 / 60, 4),        # Sonnet: the expensive one
    "/listen": (30 / 60, 8),     # Whisper on the CPU
    "/speak": (20 / 60, 6),
    "/confirm": (20 / 60, 6), "/watch": (20 / 60, 6), "/reset": (10 / 60, 3),
    "/client-log": (30 / 60, 10),
}
ROOM_COOKIE = "jarvis_room"
ROOM_COOKIE_AGE = 7 * 24 * 3600
# Pages a visitor opens directly. Opening one without a room cookie hands out a new room id; the
# room itself is only created by the first API call that carries it (so crawlers cost nothing).
PAGES = {"/", "/index.html", "/capture.html", "/debug.html", "/capture-debug.html"}

# Content-Security-Policy: only our own scripts; Google Fonts for the HUD's typefaces.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' data: blob:; "
       "connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; "
       "form-action 'self'; frame-ancestors 'none'")
SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",   # the join link (?r=<room>) must never leak in a Referer
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(self), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
}
HSTS = "max-age=31536000; includeSubDomains"   # public only: Railway always serves HTTPS


def _page(message: str, status: int) -> HTMLResponse:
    return HTMLResponse(f"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>J.A.R.V.I.S.</title><body style="background:#05141c;color:#bfe9f5;font:17px system-ui;display:grid;
place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">
<div><h1 style="letter-spacing:.2em;font-size:20px">J.A.R.V.I.S.</h1><p>{message}</p></div></body>""", status_code=status)


def _refuse(request: Request, status: int, message: str, retry_after: int | None = None) -> Response:
    headers = {"Retry-After": str(retry_after)} if retry_after else {}
    if request.method == "GET" and "text/html" in request.headers.get("accept", ""):
        response = _page(message, status)
    else:
        response = JSONResponse({"detail": message}, status_code=status)
    response.headers.update(headers)
    return response


# ---------- access key: only people who scanned the QR can use the app through the tunnel ----------
# scripts/demo.sh makes a fresh random key every run and puts it in the phone link (?k=...).
# The first visit with the key sets a cookie, so the page's own requests get in too.
# Requests on the laptop itself (the HUD at localhost) never need it. No key set = open.
# Public deployments may set one too, to keep the whole site private.
ACCESS_KEY = os.getenv("JARVIS_ACCESS_KEY", "")
KEY_COOKIE = "jarvis_key"
_LOCKED = "Access denied, sir. Scan the QR code on the laptop to connect."


def _through_tunnel(request: Request) -> bool:
    """Cloudflare adds these headers to every request it forwards; local requests don't have them."""
    host = request.client.host if request.client else ""
    return ("cf-connecting-ip" in request.headers or "cf-ray" in request.headers
            or host not in ("127.0.0.1", "::1", "localhost", "testclient"))


def _client_ip(request: Request) -> str:
    """The visitor's IP. Public (behind Railway's proxy): the LAST X-Forwarded-For entry, the one
    Railway's edge appended. Earlier entries come from the client and can be forged to dodge limits
    (which is why we don't use uvicorn --forwarded-allow-ips='*': it trusts the first)."""
    if PUBLIC:
        hops = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
        if hops:
            return hops[-1]
    return request.client.host if request.client else "?"


def _cross_site(request: Request) -> bool:
    """A state-changing request sent by some other website (CSRF): its Origin isn't us."""
    origin = request.headers.get("origin")
    if request.method in ("GET", "HEAD", "OPTIONS") or not origin:
        return False
    return urlsplit(origin).netloc != request.headers.get("host", "")


@app.middleware("http")
async def security(request: Request, call_next):
    path, ip = request.url.path, _client_ip(request)
    if RATE_LIMITS and not limiter.allow(f"ip:{ip}", *PER_IP):
        return _refuse(request, 429, "Too many requests, sir. A moment, please.", 5)
    length = request.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > MAX_BODY_BYTES):
        return _refuse(request, 413, "That upload is too large, sir.")
    if _cross_site(request):
        return _refuse(request, 403, "Requests from other sites are not allowed, sir.")

    set_key = False
    if ACCESS_KEY and _through_tunnel(request):
        from_link = request.query_params.get("k", "")
        given = from_link or request.cookies.get(KEY_COOKIE, "")
        if not secrets.compare_digest(given.encode(), ACCESS_KEY.encode()):
            return _refuse(request, 403, _LOCKED)
        set_key = bool(from_link)

    room_cookie, token = None, None
    if PUBLIC:
        joining = path == "/join"
        room_id = request.query_params.get("r", "") if joining else request.cookies.get(ROOM_COOKIE, "")
        room = store.get_room(room_id) if store.valid_room_id(room_id) else None
        if joining and not room:
            return _refuse(request, 404, "That link has expired, sir. Scan the QR code on the screen again.")
        if joining:
            room_cookie = room.id
        elif not room and path in PAGES:
            if not store.valid_room_id(room_id):
                room_cookie = store.new_room_id()   # a room id for this browser; created on first use
        elif not room and _is_api(path):
            if not store.valid_room_id(room_id):
                room_id = room_cookie = store.new_room_id()
            if not limiter.allow(f"rooms:{ip}", *NEW_ROOMS_PER_IP):
                return _refuse(request, 429, "Too many new sessions from your network, sir. Try again later.", 600)
            room = store.get_room(room_id, create=True)
            if not room:
                return _refuse(request, 503, "Jarvis is attending to other guests right now, sir. "
                                             "Please try again in a few minutes.", 120)
        if room:
            limit = ROUTE_LIMITS.get(path)
            if limit and request.method == "POST" and not limiter.allow(f"{path}:{room.id}", *limit):
                return _refuse(request, 429, "One moment, sir. That's rather a lot at once.", 10)
            token = store.use(room)
    elif RATE_LIMITS:
        limit = ROUTE_LIMITS.get(path)
        if limit and request.method == "POST" and not limiter.allow(f"{path}:{ip}", *limit):
            return _refuse(request, 429, "One moment, sir. That's rather a lot at once.", 10)

    try:
        response = await call_next(request)
    finally:
        if token is not None:
            store.reset_current(token)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    if PUBLIC:
        response.headers.setdefault("Strict-Transport-Security", HSTS)
    if set_key:
        response.set_cookie(KEY_COOKIE, ACCESS_KEY, max_age=12 * 3600, httponly=True, secure=True, samesite="lax")
    if room_cookie:   # Secure whenever the visitor is on HTTPS (Railway's proxy says so in a header)
        https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "") == "https"
        response.set_cookie(ROOM_COOKIE, room_cookie, max_age=ROOM_COOKIE_AGE, httponly=True,
                            secure=https, samesite="lax")
    return response


_api_paths: set[str] = set()


@app.get("/healthz")
def healthz():
    """Liveness for Railway's health check: no room, no AI, no data."""
    return {"ok": True}


def _is_api(path: str) -> bool:
    """One of our API routes (they need a room). Static files and unknown paths (bots probing
    for /wp-login.php) don't, so they never create one."""
    if not _api_paths:
        _api_paths.update(r.path for r in app.routes if getattr(r, "methods", None) and "{" not in r.path)
        _api_paths.discard("/healthz")
    return path in _api_paths or path.startswith("/frames/")


def _room_has_space_for(item: str) -> None:
    """Raise store.Full before studying a new item that wouldn't fit (saves an AI call)."""
    mine = store.mine()
    if store.MAX_ITEMS and len(mine) >= store.MAX_ITEMS and not any(m["item"].lower() == item.lower() for m in mine):
        raise store.Full(f"I can only keep track of {store.MAX_ITEMS} things at once, sir.")


def __getattr__(name: str):
    """main._preview / _still / _watching / _activity: the current room's (tests, old scripts)."""
    room = store.current()
    attrs = {"_preview": room.preview, "_still": room.still, "_watching": room.watching, "_activity": room.activity}
    if name in attrs:
        return attrs[name]
    raise AttributeError(f"module 'main' has no attribute {name!r}")


_MY = re.compile(r"^\s*MY\s+(.+?)\s*\((.*?)\)\s*(.*)$")


def _note_my_items(frame_id: str, caption: dict) -> None:
    """Every "MY <item> (...) <where>" in a caption updates that item's last-seen record."""
    for obj in caption.get("objects") or []:
        m = _MY.match(obj)
        if m:
            store.mark_seen(m.group(1), frame_id, m.group(3) or caption.get("scene", ""),
                            caption.get("room_guess", ""), caption.get("landmarks") or [])


def _caption_in_background(frame_id: str, jpeg: bytes, session_id: int) -> None:
    try:
        caption = ai.caption_frame(jpeg, mine=store.mine())
        store.set_caption(frame_id, caption, session_id)
        if store.session() == session_id:
            _note_my_items(frame_id, caption)
            _check_watches(frame_id, caption, session_id)
    except Exception:
        log.exception("captioning %s failed", frame_id)


# ---------- "I'll keep looking for it, sir" ----------
# After sir closes the photos without picking one (POST /watch), every new frame is checked for
# that item: a "MY <item>" caption counts at once; a caption that only hints at it ("possibly
# sir's water bottle") gets a second look, which must reach answer.SURE. The first hit is announced
# like an answer (via /interaction, so the phone speaks it) and the watch ends.
def _check_watches(frame_id: str, caption: dict, session_id: int) -> None:
    room = store.current()
    with room.watch_lock:
        watched = dict(room.watching)
    if not watched:
        return
    entry = next((e for e in reversed(store.read_log()) if e["id"] == frame_id), None)
    mine = {m["item"].lower(): m for m in store.mine()}
    for item, since in watched.items():
        m = mine.get(item.lower())
        if not entry or not m or entry["ts"] < since:
            continue
        where = None
        for obj in caption.get("objects") or []:
            hit = _MY.match(obj)
            if hit and hit.group(1).lower() == item.lower():
                where = hit.group(3) or "in view"
        noun = item.lower().split()[-1].rstrip("s")
        if where is None and any("sir's" in o.lower() or noun in o.lower() for o in caption.get("objects") or []):
            best = max(ai.look_for(m, [entry]), key=lambda s: s["confidence"], default=None)
            if best and best["confidence"] >= answer.SURE:
                where = best["where"]
        if where is None or store.session() != session_id:
            continue
        with room.watch_lock:
            if room.watching.pop(item, None) is None:
                continue   # another frame announced it first
        store.mark_seen(m["item"], frame_id, where, caption.get("room_guess", ""), caption.get("landmarks") or [])
        _announce(f"(keeping an eye out for your {m['item']})", {
            "answer": f"Sir, I know where your {m['item']} is now. It's {where.rstrip('.')}.",
            "kind": "find", "item": m["item"],
            "frames": [{"id": frame_id, "url": entry["url"], "ts": entry["ts"], "note": f"{m['item']} {where}",
                        "where": where, "sure": True}]})


def _announce(question: str, result: dict) -> None:
    """Jarvis speaks up on his own: published like an answer, so every device shows and says it."""
    room = store.current()
    with room.interaction_lock:
        room.exchange = {"id": uuid.uuid4().hex, "question": question, "result": result, "source": None}


class Watch(BaseModel):
    item: str = Field(max_length=80)


@app.post("/watch")
def watch(body: Watch):
    """Sir closed the photos: none of them was it. Keep an eye out for it from now on."""
    item = next((m["item"] for m in store.mine() if m["item"].lower() == body.item.strip().lower()), None)
    if not item:
        return {"answer": "Very well, sir.", "watching": False}
    room = store.current()
    with room.watch_lock:
        room.watching[item] = time.time() * 1000
    return {"answer": f"Very well, sir. I'll keep looking for your {item}.", "watching": True}


class Confirm(BaseModel):
    item: str = Field(max_length=80)
    frame_id: str = Field(max_length=32)
    where: str | None = Field(None, max_length=200)


@app.post("/confirm")
def confirm(body: Confirm):
    """Sir tapped a photo: that's where it is. It becomes the item's last-seen record."""
    entry = next((e for e in reversed(store.read_log()) if e["id"] == body.frame_id), None)
    item = next((m["item"] for m in store.mine() if m["item"].lower() == body.item.strip().lower()), None)
    if not entry or not item:
        raise HTTPException(status_code=404, detail="Unknown item or frame.")
    caption = entry.get("caption") or {}
    where = (body.where or "").strip().rstrip(".") or _where_from_caption(item, caption) or "there"
    store.mark_seen(item, body.frame_id, where, caption.get("room_guess", ""), caption.get("landmarks") or [], force=True)
    room = store.current()
    with room.watch_lock:
        room.watching.pop(item, None)
    return {"answer": f"Very good, sir. Noted: your {item}, {where}.", "item": item, "frame_id": body.frame_id}


@app.post("/frame")
async def frame(
    background: BackgroundTasks,
    image: UploadFile = File(...),
    ts: float = Form(None),
    lat: float = Form(None),
    lon: float = Form(None),
    heading: float = Form(None),
):
    jpeg = await _read_image(image, MAX_IMAGE_BYTES)
    session_id = store.session()
    ts = ts if ts is not None and math.isfinite(ts) and ts > 0 else time.time() * 1000
    try:
        entry = store.add_frame(jpeg, ts)
    except store.Full as full:
        raise HTTPException(status_code=429, detail=str(full))
    background.add_task(_caption_in_background, entry["id"], jpeg, session_id)
    return {"id": entry["id"], "caption": None}


class Ask(BaseModel):
    question: str = Field(max_length=MAX_QUESTION_CHARS)
    source: str | None = Field(None, max_length=64)   # which device asked (a random id per page); that device speaks its own reply


# ---------- "this is my laptop, remember it" ----------
_ITEM = r"(?P<item>[a-z]+(?: [a-z]+){0,3})"
_REMEMBER = [
    # this is my laptop / these are my AirPods / they're my keys
    re.compile(rf"\b(?:this|that|it|these|those|they)(?: is| are|'s|'re| s| re) (?:my|mine) (?:own )?{_ITEM}"),
    # this laptop is mine / these keys are mine
    re.compile(rf"\b(?:this|that|the|these|those) {_ITEM} (?:is|are|'s|'re| s) (?:mine|my own)\b"),
    re.compile(rf"\bremember (?:this|that|these|those|my) {_ITEM}"),               # remember these keys
]
_NOT_REMEMBER = re.compile(r"^\s*(?:where|did|do you|have you|what|when|which|how)\b")
_STOP = {"remember", "please", "jarvis", "and", "so", "can", "could", "would", "will", "it", "them", "for",
         "now", "okay", "ok", "right", "here", "there", "is", "mine", "me", "you", "save", "keep", "track"}


def remember_item(question: str) -> str | None:
    """'Jarvis, this is my black laptop, remember it' -> 'black laptop'. None if not a remember request."""
    q = re.sub(r"[^a-z' ]+", " ", question.lower()).replace("\u2019", "'")
    q = re.sub(r"\s+", " ", q).strip()
    if _NOT_REMEMBER.match(q):
        return None
    for pattern in _REMEMBER:
        m = pattern.search(q)
        if m:
            words = m["item"].split()
            for i, w in enumerate(words):  # cut at the first filler word: "laptop please remember it"
                if w in _STOP:
                    words = words[:i]
                    break
            if words:
                return " ".join(words)
    return None


# ---------- "Jarvis, I'm leaving my AirPods here" ----------
_PLACE = [
    re.compile(rf"\b(?:i'm|i am|im) (?:putting|leaving|placing|dropping|setting) (?:down )?my {_ITEM} (?:down )?(?:here|there|right here|over here)\b"),
    re.compile(rf"\bi (?:put|left|placed|dropped|set) (?:down )?my {_ITEM} (?:down )?(?:here|there|right here|over here)\b"),
    re.compile(rf"\bmy {_ITEM} (?:is|are|goes|go|will be|'s|'re) (?:here|there|right here|over here)\b"),
    re.compile(rf"\bremember where i (?:put|left|placed) my {_ITEM}"),
    re.compile(rf"\b(?:putting|leaving|placing) my {_ITEM} (?:down )?(?:here|there|right here|over here)\b"),
]


def place_item(question: str) -> str | None:
    """'Jarvis, I'm leaving my AirPods here' -> 'airpods'. None if not a placement."""
    q = re.sub(r"[^a-z' ]+", " ", question.lower().replace("\u2019", "'"))
    q = re.sub(r"\s+", " ", q).strip()
    if _NOT_REMEMBER.match(q):
        return None
    for pattern in _PLACE:
        m = pattern.search(q)
        if m:
            words = [w for w in m["item"].split() if w not in _STOP and w not in ("down", "up")]
            if words:
                return " ".join(words)
    return None


def _where_from_caption(item: str, caption: dict) -> str:
    """Where the item is, in a few words, from the caption of the placement photo."""
    words = set(item.lower().split())
    for obj in caption.get("objects") or []:
        m = _MY.match(obj)
        if m and m.group(1).lower() == item.lower() and m.group(3):
            return m.group(3)
    for obj in caption.get("objects") or []:
        if words & set(re.findall(r"[a-z]+", obj.lower())):
            loc = re.search(r"\b(on|in|under|by|near|next to|beside|inside|behind|at)\b.*$", obj, re.I)
            if loc:
                return loc.group(0)
    scene = (caption.get("scene") or "").rstrip(".")
    return f"here ({scene[0].lower() + scene[1:]})" if scene and scene != "unclear frame" else "here"


async def _place(item: str) -> dict:
    """Save what the camera sees now as the item's location. Registers the item if it's new."""
    _room_has_space_for(item)
    frame = _current_view(caption=False)
    if not frame:
        return {"answer": "I can't see anything yet, sir. Start the camera and show me the spot.",
                "kind": "other", "frames": []}
    jpeg = (store.FRAMES / f"{frame['id']}.jpg").read_bytes()
    if not any(m["item"].lower() == item.lower() for m in store.mine()):
        await _study_and_register(item, jpeg, frame)
    session_id = store.session()
    try:
        caption = await asyncio.wait_for(asyncio.to_thread(ai.caption_frame, jpeg, store.mine()), timeout=10)
    except Exception:
        caption = dict(ai.UNCLEAR)
    store.set_caption(frame["id"], caption, session_id)
    where = _where_from_caption(item, caption)
    _note_my_items(frame["id"], caption)   # other registered items in view, too
    store.mark_seen(item, frame["id"], where, caption.get("room_guess", ""), caption.get("landmarks") or [])
    near = (caption.get("landmarks") or [None])[0]
    said = f"Very good, sir. Your {item}: {where}" + (f", near the {near}" if near and near.lower() not in where.lower() else "") + "."
    return {"answer": said, "kind": "remember",
            "frames": [{"id": frame["id"], "url": frame["url"], "ts": frame["ts"], "note": f"{item}: {where}"}]}


# Sharp full-resolution photo the phone sends with what sir says (POST /listen's `still`, or
# POST /still before a typed question). "Remember this" uses it instead of the small preview.
STILL_MAX_AGE_S = 5   # a still belongs to the request it came with: older ones are stale


def _current_view(caption: bool = True) -> dict | None:
    """What the camera sees right now, as a saved (and captioned) frame: the sharp still sent with
    the request if there is one, else the live preview, else the newest snapshot."""
    room = store.current()
    fresh_still = room.still["jpeg"] and time.time() - room.still["ts"] <= STILL_MAX_AGE_S
    fresh_preview = room.preview["jpeg"] and time.time() - room.preview["ts"] <= 3
    if fresh_still or fresh_preview:
        jpeg = room.still["jpeg"] if fresh_still else room.preview["jpeg"]
        if fresh_still:
            room.still.update(jpeg=None, ts=0.0)   # used once: never reused by a later request
        session_id = store.session()
        entry = store.add_frame(jpeg, time.time() * 1000)
        if caption:   # copy_context: the caption must land in this visitor's room
            asyncio.get_running_loop().run_in_executor(
                None, contextvars.copy_context().run, _caption_in_background, entry["id"], jpeg, session_id)
        return entry
    return store.latest()


async def _study_and_register(item: str, jpeg: bytes, frame: dict) -> str:
    """Look closely at the item (description, distinguishing marks, close-up crop) and register it.
    Returns the description (the bare item name if studying failed)."""
    try:
        study = await asyncio.wait_for(asyncio.to_thread(ai.study_item, jpeg, item), timeout=15)
    except Exception:
        log.exception("study_item(%r) failed", item)
        study = {"description": item, "marks": [], "closeup": None}
    store.remember(item, study["description"] or item, frame, study.get("marks") or [], study.get("closeup"))
    return study["description"] or item


async def _remember(item: str) -> dict:
    _room_has_space_for(item)
    frame = _current_view(caption=False)
    if not frame:
        return {"answer": "I can't see anything yet, sir. Start the camera and show it to me.",
                "kind": "other", "frames": []}
    jpeg = (store.FRAMES / f"{frame['id']}.jpg").read_bytes()
    # Study the item and caption the photo at the same time (no extra wait), so its last-seen
    # spot is a real place straight away ("on desk by the window"), not a placeholder.
    session_id = store.session()
    caption_job = asyncio.wait_for(asyncio.to_thread(ai.caption_frame, jpeg, store.mine()), timeout=15)
    description, caption = await asyncio.gather(_study_and_register(item, jpeg, frame), caption_job,
                                                return_exceptions=True)
    if isinstance(description, BaseException):
        description = item
    if isinstance(caption, BaseException):
        caption = dict(ai.UNCLEAR)
    store.set_caption(frame["id"], caption, session_id)
    store.mark_seen(item, frame["id"], _where_from_caption(item, caption),
                    caption.get("room_guess", ""), caption.get("landmarks") or [])
    said = f"Noted, sir. I'll remember your {item}" + (f": {description}." if description != item else ".")
    return {"answer": said, "kind": "remember",
            "frames": [{"id": frame["id"], "url": frame["url"], "ts": frame["ts"], "note": description}]}


async def _answer_request(body: Ask):
    """Never leave Jarvis silent on stage: time out or fail into an in-character reply."""
    try:
        budget.check()
        placed = place_item(body.question)
        if placed:
            return await _place(placed)
        item = remember_item(body.question)
        if item:
            return await _remember(item)
        captioned = [e for e in store.read_log() if e["caption"]]
        result = await asyncio.wait_for(
            asyncio.to_thread(answer.answer, body.question, captioned, store.mine(), ai.look_for), timeout=ASK_TIMEOUT_S
        )
        return result
    except budget.OverBudget as over:
        return {"answer": str(over), "kind": "other", "frames": []}
    except store.Full as full:
        return {"answer": str(full), "kind": "other", "frames": []}
    except asyncio.TimeoutError:
        log.warning("/ask timed out after %ss: %r", ASK_TIMEOUT_S, body.question)
        return {"answer": "My apologies, sir, the footage is taking longer than expected. Ask me again in a moment.",
                "kind": "other", "frames": []}
    except Exception:
        log.exception("/ask failed: %r", body.question)
        return {"answer": "I'm afraid the footage is unclear, sir.", "kind": "other", "frames": []}


# ---------- what Jarvis is doing right now, for the HUD's animations (GET /activity) ----------
# idle -> armed ("Jarvis" heard, waiting for the question) -> thinking (question in) -> answered.
ARMED_S, THINKING_S = 8, 30


def _set_activity(state: str, question: str | None = None) -> None:
    a = store.current().activity
    a.update(id=a["id"] + 1, state=state, question=question, ts=time.time())


@app.get("/activity")
def activity():
    a = dict(store.current().activity)
    a["age"] = time.time() - a["ts"]
    if (a["state"] == "armed" and a["age"] > ARMED_S) or (a["state"] == "thinking" and a["age"] > THINKING_S):
        a["state"] = "idle"
    return a


# One active demo per room: retain only the latest completed exchange for the display HUD.
@app.post("/ask")
async def ask(body: Ask):
    room = store.current()
    with room.interaction_lock:
        generation = room.exchange_generation
        room.ask_inflight += 1
    _set_activity("thinking", body.question)
    try:
        result = await _answer_request(body)
        with room.interaction_lock:
            if generation == room.exchange_generation:
                room.exchange = {"id": uuid.uuid4().hex, "question": body.question, "result": result,
                                 "source": body.source}
        _set_activity("answered", body.question)
        return result
    finally:
        with room.interaction_lock:
            room.ask_inflight -= 1


# ---------- voice in: the browser records, Whisper (stt.py) listens ----------
# "Jarvis" anywhere in the sentence, plus common mishearings, with an optional "hey"/"ok".
WAKE = re.compile(r"\b(?:(?:hey|ok|okay|hi)[\s,]+)?(?:jarvis|jarvi[sz]|j[ae]r?v[aeiu]s|jervis|javis|travis|garvis|jarbis)\b[\s,.!?]*",
                  re.I)


def split_wake(text: str) -> tuple[bool, str]:
    """(said "Jarvis"?, the question without the wake word). "Where are my keys, Jarvis?" -> (True, "Where are my keys")."""
    m = WAKE.search(text)
    if not m:
        return False, text.strip()
    rest = (text[:m.start()] + " " + text[m.end():]).strip(" ,.!?")
    return True, re.sub(r"\s+", " ", rest)


def _keep_still(jpeg: bytes | None) -> None:
    if jpeg:
        store.current().still.update(jpeg=jpeg, ts=time.time())


@app.post("/still")
async def still(image: UploadFile = File(...)):
    """A sharp photo of what the camera sees right now, sent by the phone before a typed question."""
    _keep_still(await _read_image(image, MAX_IMAGE_BYTES))
    return {"ok": True}


@app.post("/listen")
async def listen(audio: UploadFile = File(...), mode: str = Form("ask"), still: UploadFile | None = File(None),
                 can_send_still: bool = Form(False), source: str | None = Form(None), answer: bool = Form(True)):
    """One spoken utterance (16 kHz WAV from frontend/mic.js) -> what was heard, and Jarvis's answer.

    mode "ask":  everything said is the question (push-to-talk, or right after "Jarvis" alone).
    mode "wake": hands-free; act only if "Jarvis" was said. "Jarvis" alone -> armed: the next
                 utterance (sent with mode "ask") is the question.
    Reply: {"heard", "question", "armed", "result", "need_still"}; result is the /ask reply, or null.
    answer=false: only transcribe and check for "Jarvis"; the sender then plays its acknowledgement
    and asks the returned question via /ask (two steps, so the chime comes before the wait).
    can_send_still: the sender has a camera. Then "this is my X" / "I'm leaving my X here" come
    back with need_still: true and no result: the sender takes a sharp photo, POSTs it to /still
    and asks the question via /ask. Everything else needs no photo, so none is uploaded.
    """
    data = await _read_upload(audio, MAX_AUDIO_BYTES)
    if hasattr(still, "read"):  # optional upload (absent: None, or FastAPI's default marker)
        _keep_still(await _read_image(still, MAX_IMAGE_BYTES))
    mode = mode if mode in ("ask", "wake") else "ask"
    try:
        async with _ears:   # Whisper is CPU-heavy: a few at a time, the rest wait their turn
            heard = await asyncio.to_thread(stt.transcribe, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        log.exception("transcription failed")
        raise HTTPException(status_code=503, detail="Speech recognition is unavailable.")
    woke, question = split_wake(heard)
    reply = {"heard": heard, "question": None, "armed": False, "result": None, "need_still": False}
    if mode == "wake" and not woke:
        return reply  # background chatter: ignore
    if not re.search(r"[a-z]{2}", question, re.I):
        reply["armed"] = woke  # "Jarvis" on its own: listen for the question next
        if woke:
            _set_activity("armed")
        return reply
    reply["question"] = question
    _set_activity("thinking", question)
    if can_send_still is True and not hasattr(still, "read") and (place_item(question) or remember_item(question)):
        reply["need_still"] = True   # "remember this": get a sharp photo first
        return reply
    if answer is False:
        return reply   # the sender acknowledges first (a chime), then asks via /ask
    reply["result"] = await ask(Ask(question=question, source=source if isinstance(source, str) else None))
    return reply


class ClientLog(BaseModel):
    event: str = Field(max_length=200)
    detail: str = Field("", max_length=2000)


@app.post("/client-log")
def client_log(body: ClientLog):
    """The phone reports how it played (or failed to play) Jarvis's voice, so intermittent silence
    shows up in data/backend.log instead of being a mystery."""
    log.info("phone audio: %r %r", body.event[:40], body.detail[:200])   # %r: no forged log lines
    return {"ok": True}


@app.get("/interaction")
def interaction():
    return store.current().exchange


class Speak(BaseModel):
    text: str = Field(max_length=1000)


def _best_say_voice() -> str:
    """The best installed British male voice: Daniel (Premium/Enhanced) if downloaded, else Daniel.
    Download it free: System Settings → Accessibility → Spoken Content → System voice → Manage Voices."""
    if os.getenv("JARVIS_SAY_VOICE"):
        return os.environ["JARVIS_SAY_VOICE"]
    try:
        names = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return "Daniel"
    for want in ("Daniel (Premium)", "Daniel (Enhanced)"):
        if want in names:
            return want
    return "Daniel"


SAY_VOICE = _best_say_voice() if shutil.which("say") else "Daniel"


def _say_wav(text: str) -> bytes | None:
    """The Mac's own Daniel voice rendered to WAV by `say` (~0.7s). Played as a normal audio file,
    so it doesn't depend on Chrome's speechSynthesis, which can freeze browser-wide on macOS."""
    if not shutil.which("say"):
        return None
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "jarvis.wav"
        try:
            subprocess.run(["say", "-v", SAY_VOICE, "-r", "185", "-o", str(out), "--data-format=LEI16@22050",
                            text[:600]], check=True, timeout=8, capture_output=True)
            return out.read_bytes()
        except Exception:
            log.exception("say failed")
            return None


@app.post("/speak")
async def speak(body: Speak):
    """Jarvis's voice as audio: ElevenLabs if ELEVENLABS_API_KEY is set, else the Mac's Daniel voice
    via `say`. 204 only if both fail; then the HUD falls back to the browser's speechSynthesis."""
    text = (body.text or "").strip()
    if not text:
        return Response(status_code=204)
    try:
        mp3 = await asyncio.to_thread(voice.synthesize, text)
        if mp3:
            return Response(mp3, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
        wav = await asyncio.to_thread(_say_wav, text)
        if wav:
            return Response(wav, media_type="audio/wav", headers={"Cache-Control": "no-store"})
    except Exception:
        log.exception("/speak failed")
    return Response(status_code=204)


@app.get("/health")
def health():
    """Is the AI actually working? `ai_ok` is false after a failed caption call (bad key, no network)."""
    return {"ai_ok": ai.last_error is None, "ai_error": ai.last_error, "frames": len(store.read_log()),
            "speech_ready": stt._model is not None, "items": len(store.mine()), "budget": budget.status()}


# ---------- phone link: scripts/demo.sh writes the tunnel URL here; the HUD shows it as a QR code ----------
PHONE_URL_FILE = store.DATA / "phone_url.txt"


def _public_base(request: Request) -> str:
    """https://<this deployment>, from JARVIS_PUBLIC_URL, Railway's domain, or the request."""
    base = os.getenv("JARVIS_PUBLIC_URL") or (
        f"https://{os.environ['RAILWAY_PUBLIC_DOMAIN']}" if os.getenv("RAILWAY_PUBLIC_DOMAIN") else "")
    return (base or f"https://{request.url.netloc}").rstrip("/")


def _phone_url(request: Request) -> str | None:
    if PUBLIC:   # this visitor's own room: the phone that scans it joins the HUD's room
        room = store.current()
        return f"{_public_base(request)}/join?r={room.id}" if room.id != "local" else None
    url = os.getenv("JARVIS_PHONE_URL") or (PHONE_URL_FILE.read_text().strip() if PHONE_URL_FILE.exists() else "")
    return url if url.startswith("https://") else None


@app.get("/phone")
def phone(request: Request):
    """{"url": "https://….trycloudflare.com/capture.html"} once the tunnel is up, else {"url": null}.
    Public: this visitor's join link (/join?r=<room>)."""
    return {"url": _phone_url(request)}


@app.get("/join")
def join(r: str = ""):
    """The phone scanned the HUD's QR: put it in the same room, then open the camera page.
    (The middleware has already checked the room and set the cookie.)"""
    return RedirectResponse("/capture.html", status_code=303, headers={"Cache-Control": "no-store"})


@app.get("/qr.svg")
def qr_svg(request: Request):
    url = _phone_url(request)
    if not url:
        return Response(status_code=204)
    import io

    import segno
    buf = io.BytesIO()
    segno.make(url, error="m").save(buf, kind="svg", scale=8, border=2, dark="#000", light="#fff")
    return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})


@app.get("/mine")
def mine():
    return store.mine()


# Live preview: the phone sends small frames ~10x/second, several in flight. Kept in memory
# only and never captioned, except when "remember this" saves the current view as a frame.
@app.post("/preview")
async def preview(image: UploadFile = File(...), ts: float = Form(None)):
    jpeg = await _read_image(image, MAX_PREVIEW_BYTES)
    p = store.current().preview
    if ts is not None:
        if ts < p["client_ts"]:
            return {"ok": True, "stale": True}  # an older frame arriving late: keep the newer one
        p["client_ts"] = ts
    p["jpeg"] = jpeg
    p["ts"] = time.time()
    return {"ok": True}


@app.get("/preview.jpg")
def preview_jpg():
    p = store.current().preview
    if not p["jpeg"] or time.time() - p["ts"] > 3:
        return Response(status_code=204)  # no fresh preview: the HUD falls back to /latest
    return Response(p["jpeg"], media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/latest")
def latest():
    return store.latest()


@app.get("/log")
def full_log():
    return store.read_log()


@app.post("/reset")
def reset():
    room = store.current()
    with room.interaction_lock:
        if room.ask_inflight:
            raise HTTPException(status_code=409, detail="Wait for the active question before resetting memory.")
        room.exchange_generation += 1
        room.exchange = None
        _set_activity("idle")
        with room.watch_lock:
            room.watching.clear()
        store.reset()
        room.preview.update(jpeg=None, ts=0.0, client_ts=0.0)
        room.still.update(jpeg=None, ts=0.0)
    return {"ok": True}


@app.on_event("startup")
def _load_ears():
    stt.warm_up()
    if PUBLIC:
        def sweep():   # delete rooms nobody has used for a while (their photos too)
            while True:
                time.sleep(300)
                try:
                    if gone := store.evict_expired():
                        log.info("deleted %d idle room(s)", gone)
                    limiter.prune()
                except Exception:
                    log.exception("room sweep failed")
        threading.Thread(target=sweep, daemon=True).start()


@app.get("/frames/{name}")
def frame_jpg(name: str):
    """One of this visitor's photos. Only their own room's: ids are per room."""
    path = store.frame_path(name.removesuffix(".jpg")) if name.endswith(".jpg") else None
    if not path:
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


class FreshStatic(StaticFiles):
    """Static files the browser must recheck every time (cheap 304s), so after an update the
    HUD and phone never keep running old cached JavaScript."""
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# Mount this last so the API routes take priority.
app.mount("/", FreshStatic(directory=Path(__file__).resolve().parent.parent / "frontend", html=True), name="frontend")
