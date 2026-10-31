"""Ask Jarvis real questions against a caption log, with the real model. Owner: Paul (D).

Calls answer.answer() directly (no server needed) and prints each reply, its kind,
frames and latency. Needs ANTHROPIC_API_KEY in .env.

Usage (from the repo root):
    backend/.venv/bin/python tests/ask_fake.py                          # tests/fake_log.json
    backend/.venv/bin/python tests/ask_fake.py --log tests/real_log.json  # Kenny's real captions
    backend/.venv/bin/python tests/ask_fake.py -q "where's my phone?"
"""
import argparse
import json
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
load_dotenv(ROOT / ".env")

import answer  # noqa: E402

FRAME_GAP_MS = 3000
LATENCY_BUDGET_S = 5
QUESTIONS = [
    "where did I leave my helmet?",
    "how do I get back to my helmet?",
    "where's my jacket?",
    "have you seen my phone?",
    "where did I put my water bottle?",
    "where are my car keys?",
    "what room am I in right now?",
    "what have you seen so far?",
]


def load_log(path: Path) -> list[dict]:
    """Read a log and shift its timestamps so the newest frame is from a few seconds ago."""
    entries = [e for e in json.loads(path.read_text()) if e.get("caption")]
    if not entries:
        sys.exit(f"{path} has no captioned frames.")
    shift = time.time() * 1000 - FRAME_GAP_MS - entries[-1]["ts"]
    return [{**e, "ts": e["ts"] + shift} for e in entries]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--log", type=Path, default=ROOT / "tests" / "fake_log.json")
    p.add_argument("-q", "--question", action="append", help="ask this instead (repeatable)")
    args = p.parse_args()

    log = load_log(args.log)
    slow = 0
    print(f"{len(log)} frames from {args.log.name}, model {answer.ANSWER_MODEL}\n")
    for q in args.question or QUESTIONS:
        t0 = time.time()
        r = answer.answer(q, log)
        took = time.time() - t0
        slow += took > LATENCY_BUDGET_S
        flag = "  SLOW" if took > LATENCY_BUDGET_S else ""
        print(f"Q: {q}\n   [{r['kind']}] {took:.1f}s{flag}\n   {r['answer']}")
        for f in r["frames"]:
            print(f"     - {f['id']}: {f['note']}")
        print()
    if slow:
        print(f"{slow} answers took over {LATENCY_BUDGET_S}s; consider ANSWER_MODEL = 'claude-haiku-5-5'.")


if __name__ == "__main__":
    main()
