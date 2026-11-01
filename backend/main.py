"""FastAPI app. Owner: Vince (B). Implements the contract in API.md."""
import asyncio
import logging
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

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import ai  # noqa: E402
import answer  # noqa: E402
import store  # noqa: E402
import stt  # noqa: E402  (local Whisper: speech to text)
import voice  # noqa: E402  (Paul's ElevenLabs wrapper)

log = logging.getLogger("uvicorn.error")
app = FastAPI(title="jarvis")
ASK_TIMEOUT_S = float(os.getenv("ASK_TIMEOUT_S", "12"))

# ---------- access key: only people who scanned the QR can use the app through the tunnel ----------
# scripts/demo.sh makes a fresh random key every run and puts it in the phone link (?k=...).
# The first visit with the key sets a cookie, so the page's own requests get in too.
# Requests on the laptop itself (the HUD at localhost) never need it. No key set = open (dev).
ACCESS_KEY = os.getenv("JARVIS_ACCESS_KEY", "")
KEY_COOKIE = "jarvis_key"
_LOCKED = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>J.A.R.V.I.S.</title><body style="background:#05141c;color:#bfe9f5;font:17px system-ui;display:grid;
place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">
<div><h1 style="letter-spacing:.2em;font-size:20px">J.A.R.V.I.S.</h1>
<p>Access denied, sir. Scan the QR code on the laptop to connect.</p></div></body>"""


def _through_tunnel(request: Request) -> bool:
    """Cloudflare adds these headers to every request it forwards; local requests don't have them."""
    host = request.client.host if request.client else ""
    return ("cf-connecting-ip" in request.headers or "cf-ray" in request.headers
            or host not in ("127.0.0.1", "::1", "localhost", "testclient"))


@app.middleware("http")
async def require_access_key(request: Request, call_next):
    if not ACCESS_KEY or not _through_tunnel(request):
        return await call_next(request)
    from_link = request.query_params.get("k", "")
    given = from_link or request.cookies.get(KEY_COOKIE, "")
    if not secrets.compare_digest(given.encode(), ACCESS_KEY.encode()):
        if request.method == "GET" and "text/html" in request.headers.get("accept", ""):
            return HTMLResponse(_LOCKED, status_code=403)
        return Response(status_code=403)
    response = await call_next(request)
    if from_link:
        response.set_cookie(KEY_COOKIE, ACCESS_KEY, max_age=12 * 3600, httponly=True, secure=True, samesite="lax")
    return response


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
    except Exception:
        log.exception("captioning %s failed", frame_id)


@app.post("/frame")
async def frame(
    background: BackgroundTasks,
    image: UploadFile = File(...),
    ts: float = Form(None),
    lat: float = Form(None),
    lon: float = Form(None),
    heading: float = Form(None),
):
    jpeg = await image.read()
    session_id = store.session()
    entry = store.add_frame(jpeg, ts or time.time() * 1000)
    background.add_task(_caption_in_background, entry["id"], jpeg, session_id)
    return {"id": entry["id"], "caption": None}


class Ask(BaseModel):
    question: str
    source: str | None = None   # which device asked (a random id per page); that device speaks its own reply


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
_still: dict = {"jpeg": None, "ts": 0.0}
STILL_MAX_AGE_S = 5   # a still belongs to the request it came with: older ones are stale


def _current_view(caption: bool = True) -> dict | None:
    """What the camera sees right now, as a saved (and captioned) frame: the sharp still sent with
    the request if there is one, else the live preview, else the newest snapshot."""
    fresh_still = _still["jpeg"] and time.time() - _still["ts"] <= STILL_MAX_AGE_S
    fresh_preview = _preview["jpeg"] and time.time() - _preview["ts"] <= 3
    if fresh_still or fresh_preview:
        jpeg = _still["jpeg"] if fresh_still else _preview["jpeg"]
        if fresh_still:
            _still.update(jpeg=None, ts=0.0)   # used once: never reused by a later request
        session_id = store.session()
        entry = store.add_frame(jpeg, time.time() * 1000)
        if caption:
            asyncio.get_running_loop().run_in_executor(None, _caption_in_background, entry["id"], jpeg, session_id)
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
        placed = place_item(body.question)
        if placed:
            return await _place(placed)
        item = remember_item(body.question)
        if item:
            return await _remember(item)
        captioned = [e for e in store.read_log() if e["caption"]]
        result = await asyncio.wait_for(
            asyncio.to_thread(answer.answer, body.question, captioned, store.mine()), timeout=ASK_TIMEOUT_S
        )
        return result
    except asyncio.TimeoutError:
        log.warning("/ask timed out after %ss: %r", ASK_TIMEOUT_S, body.question)
        return {"answer": "My apologies, sir, the footage is taking longer than expected. Ask me again in a moment.",
                "kind": "other", "frames": []}
    except Exception:
        log.exception("/ask failed: %r", body.question)
        return {"answer": "I'm afraid the footage is unclear, sir.", "kind": "other", "frames": []}


# ---------- what Jarvis is doing right now, for the HUD's animations (GET /activity) ----------
# idle -> armed ("Jarvis" heard, waiting for the question) -> thinking (question in) -> answered.
_activity: dict = {"id": 0, "state": "idle", "question": None, "ts": 0.0}
ARMED_S, THINKING_S = 8, 30


def _set_activity(state: str, question: str | None = None) -> None:
    _activity.update(id=_activity["id"] + 1, state=state, question=question, ts=time.time())


@app.get("/activity")
def activity():
    a = dict(_activity)
    a["age"] = time.time() - a["ts"]
    if (a["state"] == "armed" and a["age"] > ARMED_S) or (a["state"] == "thinking" and a["age"] > THINKING_S):
        a["state"] = "idle"
    return a


# One active demo: retain only the latest completed exchange for the display HUD.
_exchange = None
_exchange_generation = 0
_ask_inflight = 0
_interaction_lock = threading.Lock()


@app.post("/ask")
async def ask(body: Ask):
    global _exchange, _ask_inflight
    with _interaction_lock:
        generation = _exchange_generation
        _ask_inflight += 1
    _set_activity("thinking", body.question)
    try:
        result = await _answer_request(body)
        with _interaction_lock:
            if generation == _exchange_generation:
                _exchange = {"id": uuid.uuid4().hex, "question": body.question, "result": result, "source": body.source}
        _set_activity("answered", body.question)
        return result
    finally:
        with _interaction_lock:
            _ask_inflight -= 1


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
        _still.update(jpeg=jpeg, ts=time.time())


@app.post("/still")
async def still(image: UploadFile = File(...)):
    """A sharp photo of what the camera sees right now, sent by the phone before a typed question."""
    _keep_still(await image.read())
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
    data = await audio.read()
    if hasattr(still, "read"):  # optional upload (absent: None, or FastAPI's default marker)
        _keep_still(await still.read())
    try:
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
    event: str
    detail: str = ""


@app.post("/client-log")
def client_log(body: ClientLog):
    """The phone reports how it played (or failed to play) Jarvis's voice, so intermittent silence
    shows up in data/backend.log instead of being a mystery."""
    log.info("phone audio: %s %s", body.event[:40], body.detail[:200])
    return {"ok": True}


@app.get("/interaction")
def interaction():
    return _exchange


class Speak(BaseModel):
    text: str


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
            "speech_ready": stt._model is not None, "items": len(store.mine())}


# ---------- phone link: scripts/demo.sh writes the tunnel URL here; the HUD shows it as a QR code ----------
PHONE_URL_FILE = store.DATA / "phone_url.txt"


def _phone_url() -> str | None:
    url = os.getenv("JARVIS_PHONE_URL") or (PHONE_URL_FILE.read_text().strip() if PHONE_URL_FILE.exists() else "")
    return url if url.startswith("https://") else None


@app.get("/phone")
def phone():
    """{"url": "https://….trycloudflare.com/capture.html"} once the tunnel is up, else {"url": null}."""
    return {"url": _phone_url()}


@app.get("/qr.svg")
def qr_svg():
    url = _phone_url()
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
_preview: dict = {"jpeg": None, "ts": 0.0, "client_ts": 0.0}


@app.post("/preview")
async def preview(image: UploadFile = File(...), ts: float = Form(None)):
    jpeg = await image.read()
    if ts is not None:
        if ts < _preview["client_ts"]:
            return {"ok": True, "stale": True}  # an older frame arriving late: keep the newer one
        _preview["client_ts"] = ts
    _preview["jpeg"] = jpeg
    _preview["ts"] = time.time()
    return {"ok": True}


@app.get("/preview.jpg")
def preview_jpg():
    if not _preview["jpeg"] or time.time() - _preview["ts"] > 3:
        return Response(status_code=204)  # no fresh preview: the HUD falls back to /latest
    return Response(_preview["jpeg"], media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/latest")
def latest():
    return store.latest()


@app.get("/log")
def full_log():
    return store.read_log()


@app.post("/reset")
def reset():
    global _exchange, _exchange_generation
    with _interaction_lock:
        if _ask_inflight:
            raise HTTPException(status_code=409, detail="Wait for the active question before resetting memory.")
        _exchange_generation += 1
        _exchange = None
        _set_activity("idle")
        store.reset()
        _preview.update(jpeg=None, ts=0.0, client_ts=0.0)
        _still.update(jpeg=None, ts=0.0)
    return {"ok": True}


@app.on_event("startup")
def _load_ears():
    stt.warm_up()


class FreshStatic(StaticFiles):
    """Static files the browser must recheck every time (cheap 304s), so after an update the
    HUD and phone never keep running old cached JavaScript."""
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/frames", StaticFiles(directory=store.FRAMES), name="frames")
# Mount this last so the API routes take priority.
app.mount("/", FreshStatic(directory=Path(__file__).resolve().parent.parent / "frontend", html=True), name="frontend")
