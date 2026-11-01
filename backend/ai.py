"""Frame captioning: Jarvis's eyes. Owner: Kenny (C).

caption_frame: one photo -> Caption (claude-haiku-5-5, vision, structured output).
  With `mine` (store.mine()), sir's registered items are written "MY <item> (<description>) <where>".
describe_item: one photo + an item name -> a short phrase that identifies that exact item.
Shapes match API.md. Set ECHO_STUB_AI=1 to get fake data with no API key.

Try it without the server:
    backend/.venv/bin/python backend/ai.py samples/*.jpg
"""
import base64
import json
import logging
import os
import re
import time
from pathlib import Path

import anthropic
from pydantic import BaseModel

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"
CAPTION_MODEL = "claude-haiku-5-5"
UNCLEAR = {"scene": "unclear frame", "room_guess": "unknown", "objects": [], "landmarks": []}

log = logging.getLogger("uvicorn.error")
_client: anthropic.Anthropic | None = None
# The last API failure as one line ("AuthenticationError: invalid x-api-key"), or None once a call
# succeeds. GET /health reports it, so a dead key shows up instead of silent "unclear frame"s.
last_error: str | None = None


def _failed(what: str, err: Exception) -> None:
    global last_error
    last_error = f"{type(err).__name__}: {getattr(err, 'message', None) or err}"[:200]
    log.error("%s failed: %s", what, last_error)


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


FRAMES = PROMPTS.parent / "data" / "frames"  # where store.py saves frames (the registration photos)
MAX_REFS = 3  # reference photos per caption call: each one adds ~0.5s


def _image(jpeg: bytes) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": _media_type(jpeg),
                                        "data": base64.standard_b64encode(jpeg).decode()}}


def _mine_blocks(mine) -> list[dict]:
    """Sir's registered items as content blocks: a line of text, plus the registration photo if saved."""
    blocks, refs = [], 0
    for m in mine or ():
        if not isinstance(m, dict) or not str(m.get("item", "")).strip():
            continue
        item, desc = str(m["item"]).strip(), str(m.get("description", "")).strip() or str(m["item"]).strip()
        line = f'Registered: MY {item} = "{desc}".'
        photo = FRAMES / f"{m.get('frame_id', '')}.jpg"
        if refs < MAX_REFS and m.get("frame_id") and photo.is_file():
            refs += 1
            blocks += [{"type": "text", "text": line + " Reference photo of it (sir was pointing the camera at it):"},
                       _image(photo.read_bytes())]
        else:
            blocks.append({"type": "text", "text": line})
    if blocks:
        blocks.insert(0, {"type": "text", "text": "Sir's registered items, for MY tagging only. Do not caption these "
                                                  "reference photos; caption only the frame below."})
        blocks.append({"type": "text", "text": "The frame to log:"})
    return blocks


def caption_frame(jpeg: bytes, mine: list[dict] = ()) -> dict:
    """Return a Caption: {scene, room_guess, objects, landmarks}. Never raises.

    mine: registered items [{item, description, ...}] from store.mine(). Optional.
    """
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
            messages=[{"role": "user", "content": [*_mine_blocks(mine), _image(jpeg),
                                                   {"type": "text", "text": "Log this frame."}]}],
            output_format=Caption,
        )
    except Exception as err:  # API, network, or parse error: never crash the pipeline
        _failed("caption", err)
        return dict(UNCLEAR)
    global last_error
    last_error = None
    if resp.stop_reason == "refusal" or resp.parsed_output is None:
        log.warning("caption got no output (stop_reason=%s, request=%s)", resp.stop_reason, resp._request_id)
        return dict(UNCLEAR)
    return _exact_mine(resp.parsed_output.model_dump(), mine)


def _exact_mine(cap: dict, mine) -> dict:
    """Make every "MY <item> (...)" carry the registered description word for word, so answers can match it."""
    desc = {str(m.get("item", "")).strip().lower(): str(m.get("description", "")).strip()
            for m in mine or () if isinstance(m, dict) and m.get("item") and m.get("description")}
    if not desc:
        return cap

    def fix(obj: str) -> str:
        m = re.match(r"\s*MY\s+(.+?)\s*\((.*?)\)\s*(.*)$", obj)
        if not m:
            return obj
        item = m.group(1).strip()
        d = desc.get(item.lower())
        if d is None:  # unregistered item tagged MY: drop the tag rather than mislead Jarvis
            return f"{m.group(2)} {m.group(3)}".strip()
        return f"MY {item} ({d}) {m.group(3)}".strip()

    cap["objects"] = [fix(o) for o in cap.get("objects", [])]
    return cap


# ---------- describing one of sir's items ("this is my laptop") ----------

DESCRIBE_PROMPT = """You are the vision system of J.A.R.V.I.S. Sir is pointing the camera at one of his own items
and says it is his. Describe THAT item in one short phrase (4 to 10 words) that would pick it
out from other items of the same kind in a crowded room.

Include: its color, the brand or model if you can read or recognize it, and one or two marks
only this one has: stickers, a case or cover, a logo, a pattern, a strap, size, damage, or
what's on its screen. Format: "<color> <brand/kind> <item> with <mark>".
Good: "silver MacBook with a pumpkin sticker", "black Dell monitor with a cracked bezel",
"navy Herschel backpack with a red keychain".
Bad: "open silver laptop on a folding table" (says where it is and nothing distinctive).

Never mention where it is, what it's on, or what's around it: it will be moved. If several
items match, describe the one closest to the center of the photo. If no such item is visible,
set visible to false and leave description empty."""


class Described(BaseModel):
    visible: bool
    description: str


def describe_item(jpeg: bytes, item: str) -> str:
    """One short phrase that identifies this exact item, e.g. "silver MacBook with a pumpkin sticker".

    Returns `item` itself on any error. Never raises.
    """
    if os.environ.get("ECHO_STUB_AI") == "1":
        return f"red {item} with a gold stripe"
    try:
        resp = _client_().messages.parse(
            model=CAPTION_MODEL,
            max_tokens=1024,
            output_config={"effort": "low"},
            system=DESCRIBE_PROMPT,
            messages=[{"role": "user", "content": [
                _image(jpeg),
                {"type": "text", "text": f"Sir says: this is my {item}."},
            ]}],
            output_format=Described,
        )
    except Exception as err:
        _failed("describe_item", err)
        return item
    out = resp.parsed_output
    if resp.stop_reason == "refusal" or out is None or not out.visible:
        return item
    text = " ".join(out.description.split()).strip(" .\"'")
    # It will be moved, so a location is worse than useless: cut a trailing "near the bench" etc.
    text = re.sub(r"\s+(?:,\s*)?(?:near|next to|beside|by|against|leaning|sitting|resting|lying|placed|"
                  r"on (?:a|the|top of)|under (?:a|the)|in front of)\b.*$", "", text, flags=re.I).strip(" ,.")
    if not text or len(text.split()) > 14:
        return item
    return text


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
