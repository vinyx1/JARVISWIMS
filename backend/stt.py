"""Speech to text: Jarvis's ears. Runs Whisper locally (faster-whisper), so no key and no cloud.

The browser (frontend/mic.js) sends one utterance as a 16 kHz mono 16-bit WAV. We decode it
ourselves (no ffmpeg) and hand the samples to Whisper. small.en takes ~0.9s on an M-series Mac.

    transcribe(wav_bytes) -> "hey jarvis where did i leave my helmet"   ('' if nothing usable)
    warm_up()             -> load the model in the background at server start

JARVIS_STT_MODEL picks the model: small.en (default, best in noise) or base.en (~0.25s).
"""
import io
import logging
import os
import threading
import wave

import numpy as np

log = logging.getLogger("uvicorn.error")
MODEL_NAME = os.getenv("JARVIS_STT_MODEL", "small.en")
RATE = 16000
# Nudges Whisper toward spelling "Jarvis" (not "Travis"). Kept to a name, not a sentence:
# on near-silence Whisper can echo its prompt, and an echoed question would be acted on.
PROMPT = "Jarvis."
# What Whisper "hears" in noise or silence. Never a real question.
HALLUCINATIONS = {"", "you", "thank you", "thanks for watching", "bye", "okay", "the end"}

_model = None
_lock = threading.Lock()


def _load():
    global _model
    with _lock:
        if _model is None:
            from faster_whisper import WhisperModel
            log.info("loading Whisper %s…", MODEL_NAME)
            _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
            log.info("Whisper %s ready", MODEL_NAME)
    return _model


def warm_up() -> None:
    """Load the model now (in a thread) so the first question isn't slow."""
    def run():
        try:
            _load()
        except Exception:
            log.exception("Whisper failed to load; voice input will not work")
    threading.Thread(target=run, daemon=True).start()


def decode_wav(data: bytes) -> np.ndarray:
    """16-bit PCM WAV -> float32 mono samples at 16 kHz. Raises ValueError on anything else."""
    try:
        with wave.open(io.BytesIO(data)) as w:
            if w.getsampwidth() != 2:
                raise ValueError("expected 16-bit PCM")
            channels, rate = w.getnchannels(), w.getframerate()
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    except wave.Error as e:
        raise ValueError(f"not a WAV file: {e}") from e
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    if rate != RATE and len(pcm):
        n = int(len(pcm) * RATE / rate)
        pcm = np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm).astype(np.float32)
    return pcm


def transcribe(data: bytes) -> str:
    """The words in one WAV utterance, or '' if it was silence, noise or too short."""
    audio = decode_wav(data)
    if len(audio) < RATE * 0.3:
        return ""
    segments, _ = _load().transcribe(
        audio, language="en", beam_size=1, without_timestamps=True,
        condition_on_previous_text=False, initial_prompt=PROMPT,
    )
    words = [s.text.strip() for s in segments if s.no_speech_prob < 0.6 and s.avg_logprob > -1.2]
    text = " ".join(w for w in words if w).strip()
    if text.lower().strip(" .!?,") in HALLUCINATIONS:
        return ""
    return text
