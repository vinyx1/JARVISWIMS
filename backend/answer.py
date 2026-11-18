"""Answering questions: Jarvis's brain and voice. Owner: Paul (D).

answer(question, log, mine) sends the caption log (text only), sir's registered items, and prompts/answer.md to
ANSWER_MODEL and returns the /ask shape from API.md. The model only supplies frame
ids and notes; ids are checked against `log` and url/ts are filled in from it.

If the model call fails (no key, network, refusal, bad JSON), a keyword search over
the captions answers instead, so the live demo still finds the helmet. If that finds
nothing, it returns ERROR_REPLY (CLAUDE.md integration rule 3).
"""
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

import anthropic
from pydantic import BaseModel

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"
ANSWER_MODEL = "claude-sonnet-5-5"  # switch to "claude-haiku-5-5" if /ask takes > 5s
ANSWER_EFFORT = "low"
MAX_TOKENS = 2000
MAX_LOG_ENTRIES = 200
# One attempt, no retry, well inside main.py's 12s /ask limit, so a slow or failed call still
# leaves time for the keyword fallback instead of the "taking longer than expected" reply.
API_TIMEOUT_S = 8

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
        _client = anthropic.Anthropic(timeout=API_TIMEOUT_S, max_retries=0)
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


def _resolve_frames(refs: list[FrameRef], entries: list[dict], mine=()) -> list[dict]:
    """Keep only ids that exist in the log (or a registered item's last-seen record), in the
    model's order, with url/ts from there."""
    by_id = {s["frame_id"]: {"url": s["url"], "ts": s["ts"]}
             for m in mine or () if isinstance(m, dict)
             for s in [m.get("last_seen")] if isinstance(s, dict) and s.get("frame_id") and s.get("url")}
    by_id.update({e["id"]: e for e in entries})
    return [
        {"id": r.id, "url": by_id[r.id]["url"], "ts": by_id[r.id]["ts"], "note": r.note}
        for r in refs
        if r.id in by_id
    ]


def _format_mine(mine, now_ms: float | None = None) -> str:
    """Sir's registered items, each with its last-seen record (which never expires)."""
    now_ms = now_ms if now_ms is not None else time.time() * 1000
    lines = []
    for m in mine or ():
        if not isinstance(m, dict) or not m.get("item"):
            continue
        line = f"- MY {m['item']}: {m.get('description') or m['item']}"
        seen = m.get("last_seen")
        if isinstance(seen, dict) and seen.get("frame_id"):
            near = ", near " + ", ".join(seen["landmarks"]) if seen.get("landmarks") else ""
            room = f" ({seen['room']})" if seen.get("room") and seen["room"] != "unknown" else ""
            line += (f". Last seen: {seen.get('where') or 'unknown spot'}{room}{near}, "
                     f"{_ago(now_ms - seen['ts'])}, frame {seen['frame_id']}")
        lines.append(line)
    if not lines:
        return ""
    return ("Sir's registered items (captions tag them as MY <item>). Each last-seen record is "
            "kept even when its frame is older than the log below:\n" + "\n".join(lines) + "\n\n")


def _ask_model(question: str, entries: list[dict], now_ms: float, mine=()) -> AnswerOut | None:
    """Return the model's validated reply, or None on refusal. Raises on API/parse errors."""
    user_text = (
        f"{_format_mine(mine, now_ms)}"
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


def _words(text: str) -> set[str]:
    return {w.rstrip("s") for w in re.findall(r"[a-z]+", text.lower())}


def asked_item(question: str, mine) -> dict | None:
    """The registered item the question is about ("where's my bottle?" -> the water bottle), or None.
    Every word of its name, or at least its last word (the noun), must appear in the question."""
    asked, best = _words(question), None
    for m in mine or ():
        if not isinstance(m, dict) or not str(m.get("item", "")).strip():
            continue
        name = re.findall(r"[a-z]+", m["item"].lower())
        if not name:
            continue
        score = 2 if {w.rstrip("s") for w in name} <= asked else 1 if name[-1].rstrip("s") in asked else 0
        if score and (best is None or score > best[0]):
            best = (score, m)
    return best[1] if best else None


LOOK_SKIP = re.compile(r"^unclear frame|nearly all black|almost entirely black|no discernible", re.I)


def frames_since_sighting(item: dict, entries: list[dict], limit: int = 16) -> list[dict]:
    """The frames worth a second look for `item`: newer than its last confirmed sighting (a
    `MY <item> (` caption or its last-seen record), without blank frames, newest first. Frames whose
    caption mentions the item ("possibly sir's water bottle", "black bottle in hand") always make
    the cut, so a glimpse isn't pushed out by the frames that came after it."""
    tag = f"MY {item['item']} (".lower()
    noun = re.findall(r"[a-z]+", item["item"].lower())[-1].rstrip("s")
    seen = item.get("last_seen") if isinstance(item.get("last_seen"), dict) else {}
    since = max([seen.get("ts") or 0] + [e["ts"] for e in entries
                                         if any(o.lower().startswith(tag) for o in e["caption"].get("objects", []))])
    newer = [e for e in reversed(entries) if e["ts"] > since and not LOOK_SKIP.search(e["caption"].get("scene", ""))
             and (e["caption"].get("objects") or e["caption"].get("landmarks"))]
    hinted = lambda e: any("sir's" in o.lower() or noun in _words(o) for o in e["caption"].get("objects", []))
    keep = {e["id"] for e in [e for e in newer if hinted(e)][:limit]}
    keep |= {e["id"] for e in [e for e in newer if e["id"] not in keep][:limit - len(keep)]}
    return [e for e in newer if e["id"] in keep]


SURE = 80    # a sighting this confident is where it is: "Aha, found it, sir."
MAYBE = 55   # down to this, it's offered as "it might also be…"; anything lower is ignored


def _from_sightings(item: dict, sightings: list[dict], entries: list[dict], text_frames: list[dict],
                    now_ms: float) -> dict | None:
    """Turn the second look into Jarvis's reply.

    The newest sighting at SURE or above is where it is. Less certain sightings (MAYBE to SURE)
    that are newer than that are offered as "it might also be…", since it may have moved since.
    With nothing at SURE, he says it might be at the newest possible spots, and the caption
    answer's frames follow. Nothing at MAYBE: None (the caption answer stands).
    Frames: the sure one first, then the possible ones newest first; each has `sure` and `where`."""
    by_id = {e["id"]: e for e in entries}
    hits = sorted((s for s in sightings if s["id"] in by_id and s["confidence"] >= MAYBE),
                  key=lambda s: by_id[s["id"]]["ts"], reverse=True)
    if not hits:
        return None
    name = item["item"]
    where = lambda s: s["where"].strip().rstrip(".")
    ago = lambda s: _ago(now_ms - by_id[s["id"]]["ts"])
    frame = lambda s, sure: {"id": s["id"], "url": by_id[s["id"]]["url"], "ts": by_id[s["id"]]["ts"],
                             "note": f"{name} {where(s)}", "where": where(s), "sure": sure}
    lead = next((s for s in hits if s["confidence"] >= SURE), None)
    if lead:
        newer = [s for s in hits if by_id[s["id"]]["ts"] > by_id[lead["id"]]["ts"]]
        said = f"Aha, found it, sir. Your {name} was {where(lead)}, {ago(lead)}."
        if newer:
            said += f" It might also be {where(newer[0])}, a little later."
        frames = [frame(lead, True)] + [frame(s, False) for s in newer]
    else:
        said = f"I can't be certain, sir, but your {name} might be {where(hits[0])}, {ago(hits[0])}."
        if len(hits) > 1:
            said += f" Or possibly {where(hits[1])}."
        frames = [frame(s, False) for s in hits]
        shown = {f["id"] for f in frames}
        frames += sorted(({**f, "sure": False} for f in text_frames if f["id"] not in shown),
                         key=lambda f: f["ts"], reverse=True)
    return {"answer": said, "kind": "find", "item": name, "frames": frames}


def answer(question: str, log: list[dict], mine: list[dict] = (), look=None) -> dict:
    """Return {answer, kind, frames: [{id, url, ts, note}]}.

    `log` holds only the frames that have finished captioning, oldest first.
    `mine` is store.mine(): sir's registered items, [{item, description, ...}].
    `look(item, entries) -> [{id, where, confidence}]` (ai.look_for): when the question is about a
    registered item, the photos since its last confirmed sighting get a second look, alongside the
    caption answer, and a newer sighting wins (it may have been moved somewhere the captions missed).
    """
    entries = log[-MAX_LOG_ENTRIES:]
    if not entries and not any(isinstance(m, dict) and m.get("last_seen") for m in mine or ()):
        return {**EMPTY_LOG_REPLY, "frames": []}
    now_ms = time.time() * 1000
    item = asked_item(question, mine)
    recheck = frames_since_sighting(item, entries) if item and look else []
    pool = ThreadPoolExecutor(max_workers=1) if recheck else None
    second_look = pool.submit(look, item, recheck) if pool else None
    try:
        try:
            out = _ask_model(question, entries, now_ms, mine)
        except Exception:
            logger.exception("answering %r failed; using keyword fallback", question)
            out = None
        result = (_keyword_fallback(question, entries, now_ms) if out is None else
                  {"answer": out.answer, "kind": out.kind, "frames": _resolve_frames(out.frames, entries, mine)})
        if result["kind"] == "find":   # the screen shows the first as LAST SEEN: newest first, always
            result["frames"].sort(key=lambda f: f["ts"], reverse=True)
        if second_look:
            try:
                sightings = second_look.result()
            except Exception:
                logger.exception("second look for %r failed", item.get("item"))
                sightings = []
            logger.info("second look for %s over %d frames: %s", item["item"], len(recheck), sightings)
            found = _from_sightings(item, sightings, entries, result["frames"], now_ms)
            if found:
                return found
        if item and result["kind"] == "find":
            result["item"] = item["item"]   # the phone can then confirm a photo or ask him to keep looking
        return result
    finally:
        if pool:
            pool.shutdown(wait=False)
