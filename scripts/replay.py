"""Simulate the phone: send every image in a folder to /frame, one every few seconds.
Owner: Vince (B). The whole team uses it to test without walking around.

Usage (from the repo root, with the backend running):
    backend/.venv/bin/python scripts/replay.py                    # samples/, every 3s
    backend/.venv/bin/python scripts/replay.py samples/ --every 1 --reset
    backend/.venv/bin/python scripts/replay.py samples/ --url https://<tunnel>.trycloudflare.com
"""
import argparse
import time
from pathlib import Path

import httpx
from photos import find_images

p = argparse.ArgumentParser()
p.add_argument("folder", nargs="?", default="samples", help="scenario folder, e.g. samples/vince")
p.add_argument("--url", default="http://localhost:8000")
p.add_argument("--every", type=float, default=3.0, help="seconds between frames")
p.add_argument("--reset", action="store_true", help="clear the log first")
args = p.parse_args()

images = find_images(args.folder)

with httpx.Client(base_url=args.url, timeout=30) as client:
    if args.reset:
        client.post("/reset").raise_for_status()
    for i, img in enumerate(images):
        mime = "image/png" if img.suffix.lower() == ".png" else "image/jpeg"
        r = client.post("/frame", files={"image": (img.name, img.read_bytes(), mime)},
                        data={"ts": str(time.time() * 1000)})
        r.raise_for_status()
        print(f"[{i + 1}/{len(images)}] {img.name} -> {r.json()['id']}")
        if i < len(images) - 1:
            time.sleep(args.every)
print("Replay done.")
