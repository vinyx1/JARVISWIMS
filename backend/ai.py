"""Frame captioning: Jarvis's eyes. Owner: Kenny (C).

This is a STUB that returns fake data so the frontend and backend can be built
right away. Replace it with a real Anthropic call that uses prompts/caption.md.
Keep the function signature and the Caption shape from API.md.
"""
from pathlib import Path

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"
CAPTION_MODEL = "claude-haiku-5-5"


def caption_frame(jpeg: bytes) -> dict:
    """Return a Caption: {scene, room_guess, objects, landmarks}."""
    # TODO(Kenny): send the image plus prompts/caption.md to CAPTION_MODEL and parse the JSON.
    return {
        "scene": "stub: a dim hallway",
        "room_guess": "hallway",
        "objects": ["black jacket"],
        "landmarks": ["red poster"],
    }
