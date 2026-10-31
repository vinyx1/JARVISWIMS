"""Hear Jarvis's ElevenLabs voice from the terminal. Owner: Paul (D). macOS (afplay).

Usage (from the repo root, ELEVENLABS_API_KEY in .env):
    backend/.venv/bin/python tests/say.py
    backend/.venv/bin/python tests/say.py "Your helmet is on the grey chair, sir."
"""
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
load_dotenv(ROOT / ".env")

import voice  # noqa: E402

DEFAULT_LINE = ("Your helmet is resting on the grey chair beside the red exit sign, sir. "
                "You left it there about forty seconds ago.")

text = " ".join(sys.argv[1:]) or DEFAULT_LINE
t0 = time.time()
audio = voice.synthesize(text)
took = time.time() - t0
if audio is None:
    sys.exit(f"No audio after {took:.1f}s. Check ELEVENLABS_API_KEY in .env and the server log above.")
print(f"{len(audio) // 1024} KB of mp3 in {took:.2f}s")
with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
    f.write(audio)
    f.flush()
    subprocess.run(["afplay", f.name], check=False)
