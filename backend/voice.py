"""Jarvis's voice: text to mp3 with ElevenLabs. Owner: Paul (D).

synthesize(text) returns mp3 bytes, or None when it can't (no key, no network,
slow, quota, bad reply). None means "use the browser voice instead", so the HUD
must always keep speechSynthesis as the fallback.

The ElevenLabs key stays on the server. Never send it to the browser: the HUD is
served through a public cloudflared URL.

Our plan allows 5 concurrent ElevenLabs requests. Going over returns 429, and that
line would fall back to the browser voice (Jarvis suddenly sounding like a robot).
So: at most MAX_CONCURRENT calls at once, one retry on 429, and repeated lines
(fillers, "Sir?") are cached in memory.

.env:
    ELEVENLABS_API_KEY=...          # required
    ELEVENLABS_VOICE_ID=...         # optional, default: library voice "Jarvis" (UK RP)
    ELEVENLABS_MODEL=...            # optional, default: eleven_v4_turbo (~100ms)
"""
import logging
import os
import threading
import time

import httpx

API_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
DEFAULT_VOICE_ID = "wDsJlOXPqcvIUKdLXjDs"
DEFAULT_MODEL = "eleven_v4_turbo"
OUTPUT_FORMAT = "mp3_44100_128"
MAX_CHARS = 600          # Jarvis replies are 2-3 sentences; this caps credit use
# Variant C, picked by ear from an A/B/C test: low stability + high style = less flat, more Jarvis.
VOICE_SETTINGS = {"stability": 0.2, "similarity_boost": 0.75, "style": 0.75, "use_speaker_boost": True, "speed": 0.92}
TIMEOUT_S = 4.0          # past this, the browser voice is faster
MAX_CONCURRENT = 3       # below the plan's limit of 5, leaving room for other teammates' tests
RETRY_DELAY_S = 0.4
SLOT_WAIT_S = TIMEOUT_S     # /speak is public via the tunnel: never wait forever for a slot
CACHE_SIZE = 64

logger = logging.getLogger("uvicorn.error")
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
_cache: dict[tuple[str, str, str], bytes] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _remember(key: tuple[str, str, str], audio: bytes) -> None:
    with _cache_lock:
        _cache[key] = audio
        while len(_cache) > CACHE_SIZE:
            _cache.pop(next(iter(_cache)))       # drop the oldest line


class _Busy(Exception):
    """All ElevenLabs slots stayed taken for SLOT_WAIT_S."""


def _request(http: httpx.Client, voice_id: str, model: str, text: str, api_key: str) -> httpx.Response:
    # Bounded wait: a flood of /speak calls must not pile up threads in the shared pool (/ask uses it too).
    if not _slots.acquire(timeout=SLOT_WAIT_S):
        raise _Busy()
    try:
        return http.post(
            API_URL.format(voice_id=voice_id),
            params={"output_format": OUTPUT_FORMAT},
            headers={"xi-api-key": api_key},
            json={"text": text, "model_id": model, "voice_settings": VOICE_SETTINGS},
        )
    finally:
        _slots.release()


def synthesize(text: str | None, *, client: httpx.Client | None = None) -> bytes | None:
    """Return mp3 bytes for `text` in Jarvis's voice, or None if the browser should speak instead."""
    text = (text or "").strip()[:MAX_CHARS]
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not text or not api_key:
        if text:
            logger.warning("ELEVENLABS_API_KEY is not set; the browser voice will speak")
        return None

    voice_id = os.getenv("ELEVENLABS_VOICE_ID", DEFAULT_VOICE_ID)
    model = os.getenv("ELEVENLABS_MODEL", DEFAULT_MODEL)
    key = (voice_id, model, text)
    with _cache_lock:
        if key in _cache:
            return _cache[key]

    http = client or httpx.Client(timeout=TIMEOUT_S)
    try:
        r = _request(http, voice_id, model, text, api_key)
        if r.status_code == 429:                 # over the concurrency limit: wait a moment, try once more
            time.sleep(RETRY_DELAY_S)
            r = _request(http, voice_id, model, text, api_key)
    except _Busy:
        logger.warning("ElevenLabs busy for %.1fs; falling back to another voice", SLOT_WAIT_S)
        return None
    except httpx.HTTPError as e:
        logger.warning("ElevenLabs request failed (%s); the browser voice will speak", type(e).__name__)
        return None
    finally:
        if client is None:
            http.close()

    if r.status_code != 200 or not r.headers.get("content-type", "").startswith("audio/"):
        logger.warning("ElevenLabs returned %s %s: %s", r.status_code, r.headers.get("content-type"), r.text[:200])
        return None
    _remember(key, r.content)
    return r.content
