"""FastAPI app. Owner: Vince (B). Implements the contract in API.md."""
import asyncio
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Response, UploadFile
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


def _caption_in_background(frame_id: str, jpeg: bytes, session_id: int) -> None:
    try:
        store.set_caption(frame_id, ai.caption_frame(jpeg, mine=store.mine()), session_id)
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


# ---------- "this is my laptop, remember it" ----------
_ITEM = r"(?P<item>[a-z]+(?: [a-z]+){0,3})"
_REMEMBER = [
    re.compile(rf"\b(?:this|that|it)(?: is|'s| s) (?:my|mine) (?:own )?{_ITEM}"),   # this is my laptop
    re.compile(rf"\b(?:this|that|the) {_ITEM} (?:is|'s| s) (?:mine|my own)\b"),     # this laptop is mine
    re.compile(rf"\bremember (?:this|that|my) {_ITEM}"),                            # remember this laptop
]
_NOT_REMEMBER = re.compile(r"^\s*(?:where|did|do you|have you|what|when|which|how)\b")
_STOP = {"remember", "please", "jarvis", "and", "so", "can", "could", "would", "will", "it", "for",
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


def _current_view() -> dict | None:
    """What the camera sees right now, as a saved (and captioned) frame."""
    if _preview["jpeg"] and time.time() - _preview["ts"] <= 3:
        jpeg = _preview["jpeg"]
        session_id = store.session()
        entry = store.add_frame(jpeg, time.time() * 1000)
        asyncio.get_running_loop().run_in_executor(None, _caption_in_background, entry["id"], jpeg, session_id)
        return entry
    return store.latest()


async def _remember(item: str) -> dict:
    frame = _current_view()
    if not frame:
        return {"answer": "I can't see anything yet, sir. Start the camera and show it to me.",
                "kind": "other", "frames": []}
    jpeg = (store.FRAMES / f"{frame['id']}.jpg").read_bytes()
    description = item
    try:
        description = (await asyncio.wait_for(asyncio.to_thread(ai.describe_item, jpeg, item), timeout=8)) or item
    except Exception:
        log.exception("describe_item(%r) failed", item)
    store.remember(item, description, frame)
    said = f"Noted, sir. I'll remember your {item}" + (f": {description}." if description != item else ".")
    return {"answer": said, "kind": "remember",
            "frames": [{"id": frame["id"], "url": frame["url"], "ts": frame["ts"], "note": description}]}


async def _answer_request(body: Ask):
    """Never leave Jarvis silent on stage: time out or fail into an in-character reply."""
    try:
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
    try:
        result = await _answer_request(body)
        with _interaction_lock:
            if generation == _exchange_generation:
                _exchange = {"id": uuid.uuid4().hex, "question": body.question, "result": result}
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


@app.post("/listen")
async def listen(audio: UploadFile = File(...), mode: str = Form("ask")):
    """One spoken utterance (16 kHz WAV from frontend/mic.js) -> what was heard, and Jarvis's answer.

    mode "ask":  everything said is the question (push-to-talk, or right after "Jarvis" alone).
    mode "wake": hands-free; act only if "Jarvis" was said. "Jarvis" alone -> armed: the next
                 utterance (sent with mode "ask") is the question.
    Reply: {"heard", "question", "armed", "result"}; result is the /ask reply, or null.
    """
    data = await audio.read()
    try:
        heard = await asyncio.to_thread(stt.transcribe, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        log.exception("transcription failed")
        raise HTTPException(status_code=503, detail="Speech recognition is unavailable.")
    woke, question = split_wake(heard)
    reply = {"heard": heard, "question": None, "armed": False, "result": None}
    if mode == "wake" and not woke:
        return reply  # background chatter: ignore
    if not re.search(r"[a-z]{2}", question, re.I):
        reply["armed"] = woke  # "Jarvis" on its own: listen for the question next
        return reply
    reply["question"] = question
    reply["result"] = await ask(Ask(question=question))
    return reply


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
    return {"ai_ok": ai.last_error is None, "ai_error": ai.last_error, "frames": len(store.read_log())}


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
        store.reset()
        _preview.update(jpeg=None, ts=0.0, client_ts=0.0)
    return {"ok": True}


@app.on_event("startup")
def _load_ears():
    stt.warm_up()


app.mount("/frames", StaticFiles(directory=store.FRAMES), name="frames")
# Mount this last so the API routes take priority.
app.mount("/", StaticFiles(directory=Path(__file__).resolve().parent.parent / "frontend", html=True), name="frontend")
