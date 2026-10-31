"""End-to-end smoke test. Owner: Vince (B). Run it after every merge to main.

Resets the backend, replays a folder of photos, waits for every frame to be
captioned, asks a question, and checks that every response matches API.md.
Exits 0 on PASS and 1 on FAIL.

Usage (from the repo root, with the backend running):
    backend/.venv/bin/python scripts/smoke.py
    backend/.venv/bin/python scripts/smoke.py samples/ --question "Jarvis, where did I leave my helmet?"
    backend/.venv/bin/python scripts/smoke.py --url https://<tunnel>.trycloudflare.com
"""
import argparse
import sys
import time
from pathlib import Path

import httpx
from photos import find_images

p = argparse.ArgumentParser()
p.add_argument("folder", nargs="?", default="samples", help="scenario folder, e.g. samples/vince")
p.add_argument("--url", default="http://localhost:8000")
p.add_argument("--question", default="where did I leave my helmet?")
p.add_argument("--timeout", type=float, default=60, help="seconds to wait for captions")
args = p.parse_args()

failures: list[str] = []


def check(ok: bool, msg: str) -> bool:
    print(("  ok    " if ok else "  FAIL  ") + msg)
    if not ok:
        failures.append(msg)
    return ok


def valid_caption(c) -> bool:
    return (
        isinstance(c, dict)
        and isinstance(c.get("scene"), str)
        and isinstance(c.get("room_guess"), str)
        and isinstance(c.get("objects"), list)
        and isinstance(c.get("landmarks"), list)
    )


images = find_images(args.folder)

with httpx.Client(base_url=args.url, timeout=60) as c:
    print(f"1. reset + upload {len(images)} frames to {args.url}")
    check(c.post("/reset").status_code == 200, "POST /reset returns 200")
    check(c.get("/latest").json() is None, "GET /latest is null after reset")
    ids = []
    for img in images:
        mime = "image/png" if img.suffix.lower() == ".png" else "image/jpeg"
        r = c.post("/frame", files={"image": (img.name, img.read_bytes(), mime)},
                   data={"ts": str(time.time() * 1000)})
        if check(r.status_code == 200 and "id" in r.json(), f"POST /frame {img.name}"):
            ids.append(r.json()["id"])

    print("2. wait for background captions")
    start, log = time.time(), []
    while time.time() - start < args.timeout:
        log = c.get("/log").json()
        if log and all(e["caption"] is not None for e in log):
            break
        time.sleep(0.5)
    done = [e for e in log if e["caption"] is not None]
    check(len(done) == len(ids), f"{len(done)}/{len(ids)} frames captioned in {time.time() - start:.1f}s")
    for e in done:
        check(valid_caption(e["caption"]), f"{e['id']} caption shape: {str(e['caption'].get('scene'))[:60]!r}")
    latest = c.get("/latest").json()
    check(latest is not None and latest["id"] == ids[-1], "GET /latest is the newest frame")
    check(c.get(latest["url"]).status_code == 200 if latest else False, "latest frame image loads")

    print(f"3. ask: {args.question!r}")
    t0 = time.time()
    r = c.post("/ask", json={"question": args.question})
    took = time.time() - t0
    check(r.status_code == 200, f"POST /ask returns 200 ({took:.1f}s)")
    a = r.json() if r.status_code == 200 else {}
    check(isinstance(a.get("answer"), str) and a["answer"].strip() != "", "answer is a non-empty string")
    check(a.get("kind") in {"find", "retrace", "other"}, f"kind is valid: {a.get('kind')!r}")
    frames = a.get("frames")
    if check(isinstance(frames, list), f"frames is a list ({len(frames or [])} returned)"):
        known = {e["id"]: e for e in log}
        for f in frames:
            fid = f.get("id")
            check(fid in known, f"frame {fid} exists in the log (no invented ids)")
            check(all(k in f for k in ("url", "ts", "note")), f"frame {fid} has url, ts and note")
            if fid in known:
                check(f.get("url") == known[fid]["url"], f"frame {fid} url matches the log")
    if took > 5:
        print(f"  WARN  /ask took {took:.1f}s; above 5s, consider Haiku for answering")
    print(f"\n  Jarvis: {a.get('answer')}")

print(f"\n{'PASS' if not failures else f'FAIL ({len(failures)} problems)'}")
sys.exit(1 if failures else 0)
