"""Jarvis's voice: text to mp3 with ElevenLabs. Owner: Paul (D).

synthesize(text) returns mp3 bytes, or None when it can't (no key, no network,
slow, quota, bad reply). None means "use the browser voice instead", so the HUD
must always keep speechSynthesis as the fallback.

The ElevenLabs key stays on the server. Never send it to the browser: the HUD is
served through a public cloudflared URL.

.env:
    ELEVENLABS_API_KEY=...          # required
    ELEVENLABS_VOICE_ID=...         # optional, default: library voice "Jarvis" (UK RP)
    ELEVENLABS_MODEL=...            # optional, default: eleven_v4_turbo (~100ms)
"""
import logging
import os

import httpx

API_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
DEFAULT_VOICE_ID = "wDsJlOXPqcvIUKdLXjDs"
DEFAULT_MODEL = "eleven_v4_turbo"
OUTPUT_FORMAT = "mp3_44100_128"
MAX_CHARS = 600          # Jarvis replies are 2-3 sentences; this caps credit use
TIMEOUT_S = 4.0          # past this, the browser voice is faster

logger = logging.getLogger("uvicorn.error")


def synthesize(text: str | None, *, client: httpx.Client | None = None) -> bytes | None:
    """Return mp3 bytes for `text` in Jarvis's voice, or None if the browser should speak instead."""
    text = (text or "").strip()[:MAX_CHARS]
    key = os.getenv("ELEVENLABS_API_KEY")
    if not text or not key:
        if text:
            logger.warning("ELEVENLABS_API_KEY is not set; the browser voice will speak")
        return None

    voice_id = os.getenv("ELEVENLABS_VOICE_ID", DEFAULT_VOICE_ID)
    http = client or httpx.Client(timeout=TIMEOUT_S)
    try:
        r = http.post(
            API_URL.format(voice_id=voice_id),
            params={"output_format": OUTPUT_FORMAT},
            headers={"xi-api-key": key},
            json={"text": text, "model_id": os.getenv("ELEVENLABS_MODEL", DEFAULT_MODEL)},
        )
    except httpx.HTTPError as e:
        logger.warning("ElevenLabs request failed (%s); the browser voice will speak", type(e).__name__)
        return None
    finally:
        if client is None:
            http.close()

    if r.status_code != 200 or not r.headers.get("content-type", "").startswith("audio/"):
        logger.warning("ElevenLabs returned %s %s: %s", r.status_code, r.headers.get("content-type"), r.text[:200])
        return None
    return r.content
