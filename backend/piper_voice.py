"""Jarvis's free voice on servers without macOS `say` (Railway, Linux): Piper, offline TTS.

synthesize(text) -> WAV bytes, or None when no Piper voice is installed (then the browser's own
voice is the last fallback). The Docker image bakes in the British male voice "Alan"
(en_GB-alan-medium, ~60 MB) at /opt/piper. JARVIS_PIPER_VOICE points at another .onnx voice:
    python -m piper.download_voices --download-dir data/piper en_GB-northern_english_male-medium
"""
import io
import logging
import os
import threading
import wave
from pathlib import Path

log = logging.getLogger("uvicorn.error")
DEFAULT = "en_GB-alan-medium.onnx"
SEARCH = [Path("/opt/piper"), Path(__file__).resolve().parent.parent / "data" / "piper"]
LENGTH_SCALE = 1.05   # a touch slower than default: unhurried, butler-ish
MAX_CHARS = 600

_voice = None
_failed = False
_lock = threading.Lock()


def model_path() -> Path | None:
    if os.getenv("JARVIS_PIPER_VOICE"):
        path = Path(os.environ["JARVIS_PIPER_VOICE"])
        return path if path.is_file() else None
    return next((d / DEFAULT for d in SEARCH if (d / DEFAULT).is_file()), None)


def _load():
    global _voice, _failed
    if _voice is None and not _failed:
        path = model_path()
        if not path:
            _failed = True
            return None
        try:
            from piper import PiperVoice
            _voice = PiperVoice.load(path)
            log.info("Piper voice ready: %s", path.name)
        except Exception:
            _failed = True
            log.exception("Piper voice failed to load (%s)", path)
    return _voice


def available() -> bool:
    return model_path() is not None


def warm_up() -> None:
    """Load the voice in the background, so the first reply isn't slower."""
    if available():
        threading.Thread(target=lambda: _with_lock(_load), daemon=True).start()


def _with_lock(fn):
    with _lock:
        return fn()


def synthesize(text: str) -> bytes | None:
    """WAV bytes of Jarvis saying `text`, or None (no voice installed, or it failed)."""
    text = " ".join((text or "").split())[:MAX_CHARS]
    if not text:
        return None
    with _lock:   # one at a time: a reply takes ~0.3 s, and the model isn't known to be thread-safe
        voice = _load()
        if voice is None:
            return None
        try:
            from piper.config import SynthesisConfig
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wav:
                voice.synthesize_wav(text, wav, syn_config=SynthesisConfig(length_scale=LENGTH_SCALE))
            return buf.getvalue()
        except Exception:
            log.exception("Piper failed to speak")
            return None
