"""FastAPI app. Owner: Vince (B). Implements the contract in API.md."""
import asyncio
import logging
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, File, Form, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import ai  # noqa: E402
import answer  # noqa: E402
import store  # noqa: E402

log = logging.getLogger("uvicorn.error")
app = FastAPI(title="jarvis")
ASK_TIMEOUT_S = float(os.getenv("ASK_TIMEOUT_S", "12"))


def _caption_in_background(frame_id: str, jpeg: bytes) -> None:
    try:
        store.set_caption(frame_id, ai.caption_frame(jpeg))
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
    entry = store.add_frame(jpeg, ts or time.time() * 1000)
    background.add_task(_caption_in_background, entry["id"], jpeg)
    return {"id": entry["id"], "caption": None}


class Ask(BaseModel):
    question: str


@app.post("/ask")
async def ask(body: Ask):
    """Never leave Jarvis silent on stage: time out or fail into an in-character reply."""
    captioned = [e for e in store.read_log() if e["caption"]]
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(answer.answer, body.question, captioned), timeout=ASK_TIMEOUT_S
        )
    except asyncio.TimeoutError:
        log.warning("/ask timed out after %ss: %r", ASK_TIMEOUT_S, body.question)
        return {"answer": "My apologies, sir, the footage is taking longer than expected. Ask me again in a moment.",
                "kind": "other", "frames": []}
    except Exception:
        log.exception("/ask failed: %r", body.question)
        return {"answer": "I'm afraid the footage is unclear, sir.", "kind": "other", "frames": []}


@app.get("/latest")
def latest():
    return store.latest()


@app.get("/log")
def full_log():
    return store.read_log()


@app.post("/reset")
def reset():
    store.reset()
    return {"ok": True}


app.mount("/frames", StaticFiles(directory=store.FRAMES), name="frames")
# Mount this last so the API routes take priority.
app.mount("/", StaticFiles(directory=Path(__file__).resolve().parent.parent / "frontend", html=True), name="frontend")
