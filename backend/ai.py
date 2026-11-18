"""Frame captioning: Jarvis's eyes. Owner: Kenny (C).

caption_frame: one photo -> Caption (claude-haiku-5-5, vision, structured output).
  With `mine` (store.mine()), sir's registered items are written "MY <item> (<description>) <where>".
study_item: one photo + an item name -> description, distinguishing marks and a close-up crop.
Shapes match API.md. Set ECHO_STUB_AI=1 to get fake data with no API key.

Try it without the server:
    backend/.venv/bin/python backend/ai.py samples/*.jpg
"""
import base64
import io
import json
import logging
import os
import re
import time
from pathlib import Path

import anthropic
from pydantic import BaseModel

import budget

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
    if isinstance(err, budget.OverBudget):   # not a broken key: the daily cap did its job
        log.info("%s skipped: %s", what, err)
        return
    last_error = f"{type(err).__name__}: {getattr(err, 'message', None) or err}"[:200]
    log.error("%s failed: %s", what, last_error)


def _client_() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(timeout=30.0, max_retries=2)
    return _client


def _parse(client: anthropic.Anthropic, **kwargs):
    """client.messages.parse, inside the daily budget (raises budget.OverBudget when it's spent)."""
    budget.check()
    resp = client.messages.parse(**kwargs)
    budget.charge(kwargs["model"], resp)
    return resp


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


MAX_REFS = 3  # reference photos per caption call: each one adds ~0.5s


def _image(jpeg: bytes) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": _media_type(jpeg),
                                        "data": base64.standard_b64encode(jpeg).decode()}}


def _mine_blocks(mine) -> list[dict]:
    """Sir's registered items as content blocks: description and marks, plus a reference photo:
    the close-up taken at registration, else the whole registration frame."""
    import store  # local: store creates data folders on import
    blocks, refs = [], 0
    for m in mine or ():
        if not isinstance(m, dict) or not str(m.get("item", "")).strip():
            continue
        item, desc = str(m["item"]).strip(), str(m.get("description", "")).strip() or str(m["item"]).strip()
        marks = [str(x) for x in m.get("marks") or [] if str(x).strip()]
        line = f'Registered: MY {item} = "{desc}".' + (f" Its distinguishing marks: {'; '.join(marks)}." if marks else "")
        closeup = store.ref_path(m)
        photo = closeup or (store.FRAMES / f"{m.get('frame_id', '')}.jpg")
        if refs < MAX_REFS and photo.is_file():
            refs += 1
            what = "Close-up of it" if closeup else "Reference photo (sir was pointing the camera at it)"
            blocks += [{"type": "text", "text": f"{line} {what}:"}, _image(photo.read_bytes())]
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
        resp = _parse(_client_(),
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


# ---------- studying one of sir's items ("this is my laptop, remember it") ----------
# Registration is rare and must be accurate, so it uses a stronger model than captions, and
# it returns everything at once: a short description, the marks that make this one unique,
# and where it is in the photo so we can keep a close-up as the reference.

STUDY_MODEL = os.environ.get("JARVIS_STUDY_MODEL", "claude-sonnet-5-5")

STUDY_PROMPT = """You are the vision system of J.A.R.V.I.S. Sir is pointing the camera at one of his own
belongings and says it is his. Study THAT item so you can pick it out later from look-alikes
in a crowded room (other people own the same model).

- description: one short phrase, 4 to 10 words: "<color> <brand/kind> <item> with <mark>",
  e.g. "silver MacBook with a pumpkin sticker", "white AirPods Pro case with a scratched lid".
  Never mention where it is or what it sits on: it will be moved.
- marks: up to 5 short, visible features that tell THIS one apart from an identical model:
  stickers, scratches, dents, stains, wear, a case or cover, a keychain, writing, a missing
  part, an unusual color. Only what you can actually see. Empty if it looks factory-new.
- box: where the item is, in pixels of the image as given (x0, y0 top-left; x1, y1
  bottom-right), around the item itself, not what it rests on.
If several things fit, choose the one closest to the center and most in focus. If no such
item is visible, set visible to false."""


class Studied(BaseModel):
    visible: bool
    description: str
    marks: list[str]
    x0: int
    y0: int
    x1: int
    y1: int


def _strip_location(text: str) -> str:
    """It will be moved, so a location is worse than useless: cut a trailing "on the desk" etc."""
    return re.sub(r"\s+(?:,\s*)?(?:near|next to|beside|by|against|leaning|sitting|resting|lying|placed|"
                  r"on (?:a|the|top of)|under (?:a|the)|in front of)\b.*$", "", text, flags=re.I).strip(" ,.")


def crop(jpeg: bytes, box: list[float], pad: float = 0.2, min_side: int = 96) -> bytes | None:
    """Close-up of a box given as fractions [x0, y0, x1, y1], padded so nothing gets clipped."""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(jpeg)).convert("RGB")
        w, h = img.size
        x0, y0, x1, y1 = box[0] * w, box[1] * h, box[2] * w, box[3] * h
        pw, ph = (x1 - x0) * pad, (y1 - y0) * pad
        x0, y0, x1, y1 = max(0, x0 - pw), max(0, y0 - ph), min(w, x1 + pw), min(h, y1 + ph)
        if x1 - x0 < min_side:   # tiny items: keep at least a min_side square of context
            cx = (x0 + x1) / 2; x0, x1 = max(0, cx - min_side / 2), min(w, cx + min_side / 2)
        if y1 - y0 < min_side:
            cy = (y0 + y1) / 2; y0, y1 = max(0, cy - min_side / 2), min(h, cy + min_side / 2)
        out = io.BytesIO()
        img.crop((int(x0), int(y0), int(x1), int(y1))).save(out, "JPEG", quality=92)
        return out.getvalue()
    except Exception:
        log.exception("crop failed")
        return None


def _size(jpeg: bytes) -> tuple[int, int] | None:
    try:
        from PIL import Image
        return Image.open(io.BytesIO(jpeg)).size
    except Exception:
        return None


def study_item(jpeg: bytes, item: str) -> dict:
    """{"description", "marks": [...], "box": [x0, y0, x1, y1] fractions or None, "closeup": jpeg or None}.

    On any error: {"description": item, "marks": [], "box": None, "closeup": None}. Never raises.
    """
    fallback = {"description": item, "marks": [], "box": None, "closeup": None}
    if os.environ.get("ECHO_STUB_AI") == "1":
        box = [0.3, 0.3, 0.7, 0.7]
        return {"description": f"red {item} with a gold stripe", "marks": ["gold stripe", "scuffed corner"],
                "box": box, "closeup": crop(jpeg, box)}
    size = _size(jpeg)
    if not size:
        return fallback
    w, h = size
    try:
        resp = _parse(_client_(),
            model=STUDY_MODEL,
            max_tokens=1024,
            output_config={"effort": "low"},
            system=STUDY_PROMPT,
            messages=[{"role": "user", "content": [
                _image(jpeg),
                {"type": "text", "text": f"Image size: {w}x{h} pixels.\nSir says: this is my {item}."},
            ]}],
            output_format=Studied,
        )
    except Exception as err:
        _failed("study_item", err)
        return fallback
    out = resp.parsed_output
    if resp.stop_reason == "refusal" or out is None or not out.visible:
        return fallback
    text = _strip_location(" ".join(out.description.split()).strip(" .\"'"))
    description = text if text and len(text.split()) <= 14 else item
    # Marks must be on the item itself: anything about its surroundings will be wrong once it moves.
    nearby = re.compile(r"\b(beside|next to|near|nearby|behind|underneath|under it|on the|on a|on top of|"
                        r"lying on|sitting on|resting on|surrounded|background)\b", re.I)
    marks = [" ".join(m.split()).strip(" .") for m in out.marks if m.strip() and not nearby.search(m)][:5]
    x0, x1 = sorted((max(0, min(w, out.x0)), max(0, min(w, out.x1))))
    y0, y1 = sorted((max(0, min(h, out.y0)), max(0, min(h, out.y1))))
    box = [x0 / w, y0 / h, x1 / w, y1 / h] if x1 - x0 >= 4 and y1 - y0 >= 4 else None
    return {"description": description, "marks": marks, "box": box, "closeup": crop(jpeg, box) if box else None}


# ---------- a second look: "where's my X?" after it was moved ----------
# Captions are written one frame at a time by a fast model, so a small, dark or blurry glimpse of
# a moved item often gets logged as "possibly a remote". When sir asks about a registered item,
# the frames since its last confirmed sighting are shown again, with its close-up, to a stronger
# model. Haiku was tried and reported confident sightings in the wrong frames, so this uses Sonnet.

LOOK_MODEL = os.environ.get("JARVIS_LOOK_MODEL", "claude-sonnet-5-5")
LOOK_TIMEOUT_S = 9      # inside main.py's 12 s /ask limit; the caption answer runs alongside
LOOK_LONG_EDGE = 768    # tested: same answers as full size, and well under the time limit

LOOK_PROMPT = """You are the vision system of J.A.R.V.I.S. Sir has lost one of his own belongings and it has
probably been moved. You get a close-up of the item, then several camera frames (each labelled
with its id). Find every frame where THAT item is visible, however small, dark, blurry or far
off at the edge of the frame: a glimpse in the background counts. It must match the close-up
in shape, color and marks; ignore things that merely share a color.

For each frame where you see it:
- id: copied exactly from the label.
- where: where it is, as a short spoken phrase starting with a preposition, under 12 words,
  using what it sits on and the nearest distinctive thing, e.g. "on the carpet by the pink
  beanbag, next to the heater". Being carried: "in your hand by the desk". Never "on the right
  of the frame".
- confidence: 0 to 100, how likely it is THAT item and not a look-alike or a shadow.
  90+: clearly it, marks visible. 80: right shape, color and size, nothing contradicts it.
  60: a plausible glimpse (dark, blurry or far) of the right shape and color. Below 50: a
  guess; leave those out.
Return an empty list if it isn't in any frame."""


class Sighting(BaseModel):
    id: str
    where: str
    confidence: int


class Sightings(BaseModel):
    sightings: list[Sighting]


def _small(jpeg: bytes, long_edge: int = LOOK_LONG_EDGE) -> bytes:
    """Downscaled copy (faster to send and read); the original if anything goes wrong."""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(jpeg)).convert("RGB")
        if max(img.size) <= long_edge:
            return jpeg
        img.thumbnail((long_edge, long_edge))
        out = io.BytesIO()
        img.save(out, "JPEG", quality=85)
        return out.getvalue()
    except Exception:
        return jpeg


def look_for(item: dict, entries: list[dict]) -> list[dict]:
    """Look at the frames in `entries` (log entries) for sir's registered `item` (a store.mine()
    entry). Returns [{"id", "where", "confidence": 0-100}] for frames that exist in `entries`. Never raises:
    on any error, timeout or missing photos it returns []."""
    if os.environ.get("ECHO_STUB_AI") == "1" or not entries or not isinstance(item, dict):
        return []
    import store  # local: store creates data folders on import
    name = str(item.get("item", "")).strip()
    desc = str(item.get("description", "")).strip() or name
    marks = [str(x) for x in item.get("marks") or [] if str(x).strip()]
    ref = store.ref_path(item) or (store.FRAMES / f"{item.get('frame_id', '')}.jpg")
    if not name or not ref.is_file():
        return []
    content = [{"type": "text", "text": f'Sir\'s {name}: "{desc}".'
                + (f" Distinguishing marks: {'; '.join(marks)}." if marks else "") + " Close-up:"},
               _image(_small(ref.read_bytes(), 512))]
    ids = set()
    for e in entries:
        path = store.FRAMES / f"{e['id']}.jpg"
        if path.is_file():
            ids.add(e["id"])
            content += [{"type": "text", "text": f"Frame {e['id']}:"}, _image(_small(path.read_bytes()))]
    if not ids:
        return []
    content.append({"type": "text", "text": f"Where is sir's {name} in these frames?"})
    try:
        resp = _parse(_client_().with_options(timeout=LOOK_TIMEOUT_S, max_retries=0),
            model=LOOK_MODEL, max_tokens=800, output_config={"effort": "low"}, system=LOOK_PROMPT,
            messages=[{"role": "user", "content": content}], output_format=Sightings,
        )
    except Exception as err:
        _failed("look_for", err)
        return []
    if resp.stop_reason == "refusal" or resp.parsed_output is None:
        return []
    return [{**s.model_dump(), "confidence": max(0, min(100, s.confidence))}
            for s in resp.parsed_output.sightings if s.id in ids and s.where.strip()]


def describe_item(jpeg: bytes, item: str) -> str:
    """Just the description (kept for callers that only need the phrase)."""
    return study_item(jpeg, item)["description"]


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
