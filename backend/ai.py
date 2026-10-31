"""Frame captioning: Jarvis's eyes. Owner: Kenny (C).

caption_frame: one photo -> Caption (claude-haiku-5-5, vision, structured output).
Shape matches API.md. Set ECHO_STUB_AI=1 to get fake data with no API key.

Try it without the server:
    backend/.venv/bin/python backend/ai.py samples/*.jpg
"""
import base64
import json
import logging
import os
import time
from pathlib import Path

import anthropic
from pydantic import BaseModel

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"
CAPTION_MODEL = "claude-haiku-5-5"
UNCLEAR = {"scene": "unclear frame", "room_guess": "unknown", "objects": [], "landmarks": []}

log = logging.getLogger("uvicorn.error")
_client: anthropic.Anthropic | None = None


def _client_() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(timeout=30.0, max_retries=2)
    return _client


class Caption(BaseModel):
    scene: str
    room_guess: str
    objects: list[str]
    landmarks: list[str]


def _media_type(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def caption_frame(jpeg: bytes) -> dict:
    """Return a Caption: {scene, room_guess, objects, landmarks}. Never raises."""
    if os.environ.get("ECHO_STUB_AI") == "1":
        return {"scene": "stub: red Iron Man helmet on a grey chair in the hallway", "room_guess": "hallway",
                "objects": ["red Iron Man helmet on grey chair"], "landmarks": ["red exit sign"]}
    try:
        resp = _client_().messages.parse(
            model=CAPTION_MODEL,
            max_tokens=1024,
            output_config={"effort": "low"},
            # Re-read each call so prompt edits apply without restarting the server.
            system=(PROMPTS / "caption.md").read_text(),
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": _media_type(jpeg),
                                             "data": base64.standard_b64encode(jpeg).decode()}},
                {"type": "text", "text": "Log this frame."},
            ]}],
            output_format=Caption,
        )
    except Exception:  # API, network, or parse error: never crash the pipeline
        log.exception("caption call failed")
        return dict(UNCLEAR)
    if resp.stop_reason == "refusal" or resp.parsed_output is None:
        log.warning("caption got no output (stop_reason=%s, request=%s)", resp.stop_reason, resp._request_id)
        return dict(UNCLEAR)
    return resp.parsed_output.model_dump()


if __name__ == "__main__":
    import argparse

    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    ap = argparse.ArgumentParser(description="Caption images with Jarvis's eyes and print the JSON.")
    ap.add_argument("images", nargs="+", type=Path)
    for path in sorted(ap.parse_args().images):
        t0 = time.time()
        cap = caption_frame(path.read_bytes())
        print(f"{path.name}  ({time.time() - t0:.1f}s)  {json.dumps(cap)}")
