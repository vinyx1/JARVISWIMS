"""Answering questions: Jarvis's brain and voice. Owner: Paul (D).

This is a STUB that returns fake data. Replace it with a real Anthropic call that
uses prompts/answer.md. Keep the function signature and the /ask response shape
from API.md.
"""
from pathlib import Path

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"
ANSWER_MODEL = "claude-sonnet-5-5"


def answer(question: str, log: list[dict]) -> dict:
    """Return {answer, kind, frames: [{id, url, ts, note}]}.

    `log` holds only the frames that have finished captioning, oldest first.
    """
    # TODO(Paul): send the caption log (text only) plus prompts/answer.md to ANSWER_MODEL.
    # Validate the frame ids the model returns against `log`, and fill in url/ts from it.
    last = log[-1] if log else None
    return {
        "answer": f"(stub) Very good, sir. You asked: {question}. I have {len(log)} frames on record.",
        "kind": "other",
        "frames": [
            {"id": last["id"], "url": last["url"], "ts": last["ts"], "note": "most recent"}
        ] if last else [],
    }
