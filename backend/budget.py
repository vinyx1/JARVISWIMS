"""Daily spending cap on Claude calls, so a public deployment can't run up the bill.

Every Claude call goes through `check()` first and `charge()` after:
- JARVIS_DAILY_BUDGET_USD (default 2.00): all rooms together, per UTC day. 0 = no cap.
- JARVIS_ROOM_BUDGET_USD (default 0.25 when public, else off): one room (visitor), per UTC day.

Past either, check() raises OverBudget and Jarvis says so in character instead of calling Claude.
Spend is estimated from each response's token usage and the prices below, and saved to
<data>/budget.json so a restart or redeploy doesn't reset it. Keep a spend limit in the
Anthropic console as well: this is a second guard, not a replacement.
"""
import json
import logging
import os
import threading
import time

import store

log = logging.getLogger("uvicorn.error")

# USD per million tokens: (input, output, cache read). Unknown models are charged as Sonnet.
PRICES = {
    "claude-haiku-5-5": (0.10, 0.50, 0.01),
    "claude-sonnet-5-5": (2.00, 10.00, 0.10),
    "claude-opus-5-5": (4.00, 20.00, 0.20),
}
_DEFAULT_PRICE = PRICES["claude-sonnet-5-5"]

PUBLIC = os.getenv("JARVIS_PUBLIC", "") == "1"
DAILY_USD = float(os.getenv("JARVIS_DAILY_BUDGET_USD", "2.00"))
ROOM_USD = float(os.getenv("JARVIS_ROOM_BUDGET_USD", "0.25" if PUBLIC else "0"))
FILE = store.DATA / "budget.json"

_lock = threading.Lock()


class OverBudget(Exception):
    """Today's allowance is used up. str(e) is a line Jarvis can say."""


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _fresh() -> dict:
    return {"day": _today(), "total": 0.0, "rooms": {}}


def _read() -> dict:
    try:
        state = json.loads(FILE.read_text())
        if state.get("day") == _today():
            return state
    except (OSError, ValueError):
        pass
    return _fresh()


_state = _read()


def _roll() -> None:
    global _state
    if _state["day"] != _today():
        _state = _fresh()


def check() -> None:
    """Raise OverBudget if today's total or this room's allowance is spent."""
    room = store.current().id
    with _lock:
        _roll()
        if DAILY_USD and _state["total"] >= DAILY_USD:
            raise OverBudget("I've reached my thinking allowance for today, sir. Do try again tomorrow.")
        if ROOM_USD and room != "local" and _state["rooms"].get(room, 0.0) >= ROOM_USD:
            raise OverBudget("You've used up today's allowance for this session, sir. Do come back tomorrow.")


def cost(model: str, usage) -> float:
    """USD for one response's `usage` (an SDK Usage object or a dict)."""
    get = (lambda k: usage.get(k)) if isinstance(usage, dict) else (lambda k: getattr(usage, k, None))
    p_in, p_out, p_cache = PRICES.get(model, _DEFAULT_PRICE)
    fresh_in = (get("input_tokens") or 0) + (get("cache_creation_input_tokens") or 0) * 1.25
    return (fresh_in * p_in + (get("output_tokens") or 0) * p_out
            + (get("cache_read_input_tokens") or 0) * p_cache) / 1_000_000


def charge(model: str, response) -> float:
    """Add a response's cost to today's spend. Never raises."""
    try:
        usd = cost(model, getattr(response, "usage", None) or {})
    except Exception:
        log.exception("budget: couldn't price a %s response", model)
        return 0.0
    room = store.current().id
    with _lock:
        _roll()
        _state["total"] = round(_state["total"] + usd, 6)
        _state["rooms"][room] = round(_state["rooms"].get(room, 0.0) + usd, 6)
        try:
            FILE.parent.mkdir(parents=True, exist_ok=True)
            FILE.write_text(json.dumps(_state))
        except OSError:
            log.exception("budget: couldn't save %s", FILE)
    return usd


def status() -> dict:
    room = store.current().id
    with _lock:
        _roll()
        return {"day": _state["day"], "spent_usd": round(_state["total"], 4), "daily_usd": DAILY_USD,
                "room_spent_usd": round(_state["rooms"].get(room, 0.0), 4), "room_usd": ROOM_USD}
