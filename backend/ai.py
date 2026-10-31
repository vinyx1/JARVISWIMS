"""Claude calls. Owner: Person C.

These are STUBS that return fake data so the frontend and backend can be built
right away. Replace them with real Anthropic calls that use prompts/*.md.
Keep the function signatures and the return shapes from API.md.
"""
from pathlib import Path

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"
CAPTION_MODEL = "claude-haiku-5-5"
ANSWER_MODEL = "claude-sonnet-5-5"


def caption_frame(jpeg: bytes) -> dict:
    """Return a Caption: {scene, room_guess, objects, landmarks}."""
    # TODO(C): send the image plus prompts/caption.md to CAPTION_MODEL and parse the JSON.
    return {
        "scene": "stub: a dim hallway",
        "room_guess": "hallway",
        "objects": ["black jacket"],
        "landmarks": ["red poster"],
    }


def answer(question: str, log: list[dict]) -> dict:
    """Return {answer, kind, frames: [{id, url, ts, note}]}."""
    # TODO(C): send the caption log (text only) plus prompts/answer.md to ANSWER_MODEL.
    last = log[-1] if log else None
    return {
        "answer": f"(stub) I heard: {question}. I have seen {len(log)} moments of your past...",
        "kind": "other",
        "frames": [
            {"id": last["id"], "url": last["url"], "ts": last["ts"], "note": "most recent"}
        ] if last else [],
    }
