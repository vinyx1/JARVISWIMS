"""Answering questions: Jarvis's brain and voice. Owner: Paul (D).

answer(question, log) sends the caption log (text only) plus prompts/answer.md to
ANSWER_MODEL and returns the /ask shape from API.md. The model only supplies frame
ids and notes; ids are checked against `log` and url/ts are filled in from it.

If the model call fails (no key, network, refusal, bad JSON), a keyword search over
the captions answers instead, so the live demo still finds the helmet. If that finds
nothing, it returns ERROR_REPLY (CLAUDE.md integration rule 3).
"""
import logging
import re
import time
from pathlib import Path
from typing import Literal

import anthropic
from pydantic import BaseModel

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"
ANSWER_MODEL = "claude-sonnet-5-5"  # switch to "claude-haiku-5-5" if /ask takes > 5s
ANSWER_EFFORT = "low"
MAX_TOKENS = 2000
MAX_LOG_ENTRIES = 200
API_TIMEOUT_S = 10

SYSTEM = (PROMPTS / "answer.md").read_text()
ERROR_REPLY = {"answer": "I'm afraid the footage is unclear, sir.", "kind": "other", "frames": []}
EMPTY_LOG_REPLY = {
    "answer": "I'm afraid I haven't seen anything yet, sir. Do start the camera.",
    "kind": "other",
    "frames": [],
}
STOPWORDS = {
    "jarvis", "where", "did", "leave", "left", "put", "the", "have", "you", "seen",
    "what", "when", "how", "get", "back", "was", "are", "for", "and", "with", "this",
    "that", "find", "lost", "last", "can", "please", "sir", "help", "show",
}

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "kind": {"type": "string", "enum": ["find", "retrace", "other"]},
        "frames": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "note": {"type": "string"}},
                "required": ["id", "note"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["answer", "kind", "frames"],
    "additionalProperties": False,
}

logger = logging.getLogger("uvicorn.error")
_client: anthropic.Anthropic | None = None


class FrameRef(BaseModel):
    id: str
    note: str


class AnswerOut(BaseModel):
    answer: str
    kind: Literal["find", "retrace", "other"]
    frames: list[FrameRef]


def _get_client() -> anthropic.Anthropic:
    """Created lazily so importing this module never needs an API key (CI has none)."""
    global _client
    if _client is None:
        _client = anthropic.Anthropic(timeout=API_TIMEOUT_S, max_retries=1)
    return _client


def _ago(ms: float) -> str:
    """Elapsed time in words, ready to be spoken."""
    seconds = int(ms // 1000)
    if seconds < 5:
        return "just now"
    if seconds < 60:
        return f"{seconds} seconds ago"
    minutes = round(seconds / 60)
    return f"about {minutes} minute{'s' if minutes != 1 else ''} ago"


def _format_log(entries: list[dict], now_ms: float) -> str:
    """One line per frame, oldest first: id | ago | room | scene | objects | landmarks."""
    lines = []
    for e in entries:
        c = e["caption"]
        lines.append(" | ".join([
            e["id"],
            _ago(now_ms - e["ts"]),
            c.get("room_guess", "unknown"),
            c.get("scene", ""),
            "objects: " + ", ".join(c.get("objects", [])),
            "landmarks: " + ", ".join(c.get("landmarks", [])),
        ]))
    return "\n".join(lines)


def _resolve_frames(refs: list[FrameRef], entries: list[dict]) -> list[dict]:
    """Keep only ids that exist in the log, in the model's order, with url/ts from the log."""
    by_id = {e["id"]: e for e in entries}
    return [
        {"id": r.id, "url": by_id[r.id]["url"], "ts": by_id[r.id]["ts"], "note": r.note}
        for r in refs
        if r.id in by_id
    ]


def _ask_model(question: str, entries: list[dict], now_ms: float) -> AnswerOut | None:
    """Return the model's validated reply, or None on refusal. Raises on API/parse errors."""
    user_text = (
        f"Caption log, oldest first ({len(entries)} frames):\n"
        f"{_format_log(entries, now_ms)}\n\n"
        f"Question: {question}"
    )
    response = _get_client().messages.create(
        model=ANSWER_MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM,
        messages=[{"role": "user", "content": user_text}],
        output_config={"effort": ANSWER_EFFORT, "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
    )
    if response.stop_reason == "refusal":
        logger.warning("answer model refused: %r", question)
        return None
    text = next(b.text for b in response.content if b.type == "text")
    return AnswerOut.model_validate_json(text)


def _keyword_fallback(question: str, entries: list[dict], now_ms: float) -> dict:
    """Offline answer: the most recent caption object that shares a word with the question."""
    wanted = {w for w in re.findall(r"[a-z]+", question.lower()) if len(w) >= 3 and w not in STOPWORDS}
    for e in reversed(entries):
        for obj in e["caption"].get("objects", []):
            words = set(re.findall(r"[a-z]+", obj.lower()))
            if any(w in words or w.rstrip("s") in words for w in wanted):
                landmarks = e["caption"].get("landmarks", [])
                near = f", near the {landmarks[0]}" if landmarks else ""
                return {
                    "answer": (f"My connection is a touch unreliable, sir, but my last record shows "
                               f"{obj}{near}, {_ago(now_ms - e['ts'])}."),
                    "kind": "find",
                    "frames": [{"id": e["id"], "url": e["url"], "ts": e["ts"], "note": obj}],
                }
    return {**ERROR_REPLY, "frames": []}


def answer(question: str, log: list[dict]) -> dict:
    """Return {answer, kind, frames: [{id, url, ts, note}]}.

    `log` holds only the frames that have finished captioning, oldest first.
    """
    entries = log[-MAX_LOG_ENTRIES:]
    if not entries:
        return {**EMPTY_LOG_REPLY, "frames": []}
    now_ms = time.time() * 1000
    try:
        out = _ask_model(question, entries, now_ms)
    except Exception:
        logger.exception("answering %r failed; using keyword fallback", question)
        out = None
    if out is None:
        return _keyword_fallback(question, entries, now_ms)
    return {"answer": out.answer, "kind": out.kind, "frames": _resolve_frames(out.frames, entries)}
