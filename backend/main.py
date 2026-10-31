"""FastAPI app. Owner: Person B. Implements the contract in API.md."""
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import ai  # noqa: E402
import store  # noqa: E402

app = FastAPI(title="ghost-project")


@app.post("/frame")
async def frame(
    image: UploadFile = File(...),
    ts: float = Form(None),
    lat: float = Form(None),
    lon: float = Form(None),
    heading: float = Form(None),
):
    jpeg = await image.read()
    frame_id = store.next_id()
    url = store.save_frame(frame_id, jpeg)
    caption = ai.caption_frame(jpeg)
    store.append({"id": frame_id, "ts": ts or time.time() * 1000, "url": url, "caption": caption})
    return {"id": frame_id, "caption": caption}


class Ask(BaseModel):
    question: str


@app.post("/ask")
def ask(body: Ask):
    return ai.answer(body.question, store.read_log())


@app.get("/log")
def log():
    return store.read_log()


@app.post("/reset")
def reset():
    store.reset()
    return {"ok": True}


app.mount("/frames", StaticFiles(directory=store.FRAMES), name="frames")
# Mount this last so the API routes take priority.
app.mount("/", StaticFiles(directory=Path(__file__).resolve().parent.parent / "frontend", html=True), name="frontend")
