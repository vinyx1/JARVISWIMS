#!/usr/bin/env bash
# One command to run everything. Usually started as ./start (or double-click "Start Jarvis.command").
#   ./start          set up on first run, start backend + tunnel, clear memory, keep the Mac awake,
#                    open the HUD, and show a QR code for the iPhone (in the terminal and on the HUD)
#   ./start --keep   same, but keep the current memory (e.g. restarting mid-demo)
# Ctrl-C stops everything. Logs: data/backend.log, data/tunnel.log
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=8000
KEEP=0; [[ "${1:-}" == "--keep" ]] && KEEP=1
c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }   # c <color> <text>
die() { c 31 "✗ $1"; exit 1; }

# ---------- first-run setup (a fast no-op afterwards) ----------
command -v brew >/dev/null || die "Homebrew missing: https://brew.sh"
command -v uv >/dev/null || { c 36 "▶ Installing uv"; brew install uv || die "brew install uv failed"; }
command -v cloudflared >/dev/null || { c 36 "▶ Installing cloudflared"; brew install cloudflared || die "brew install cloudflared failed"; }
[[ -x backend/.venv/bin/python ]] || { c 36 "▶ Creating the Python environment"; uv venv -q backend/.venv || die "uv venv failed"; }
uv pip install -q --python backend/.venv/bin/python -r backend/requirements.txt || die "Installing Python packages failed"
# Jarvis's ears: the Whisper speech model (~480 MB, downloaded once, then cached).
backend/.venv/bin/python - <<'PY' 2>/dev/null || c 33 "  (couldn't fetch the speech model now; voice input will retry when used)"
import os, sys
sys.path.insert(0, "backend")
from huggingface_hub import try_to_load_from_cache
import stt
repo = f"Systran/faster-whisper-{stt.MODEL_NAME}"
if not isinstance(try_to_load_from_cache(repo, "model.bin"), str):
    print(f"\033[36m▶ Downloading Jarvis's ears (Whisper {stt.MODEL_NAME}, ~480 MB, first time only)\033[0m", flush=True)
stt._load()
PY
if ! grep -q '^ANTHROPIC_API_KEY=sk' .env 2>/dev/null; then
  [[ -f .env ]] || cp .env.example .env
  printf 'Paste your Anthropic API key (sk-ant-…), then Enter: '; read -rs KEY; echo
  [[ "$KEY" == sk-* ]] || die "That doesn't look like an Anthropic key"
  grep -v '^ANTHROPIC_API_KEY=' .env > .env.tmp; echo "ANTHROPIC_API_KEY=$KEY" >> .env.tmp; mv .env.tmp .env; unset KEY
fi
# A revoked or mistyped key doesn't crash anything: every caption just turns into "unclear frame".
# So prove it works now, with one tiny real call.
KEYCHECK=$(backend/.venv/bin/python - <<'PY' 2>/dev/null | tail -1
from pathlib import Path
from dotenv import load_dotenv
import anthropic
load_dotenv(Path(".env"))
try:
    anthropic.Anthropic(timeout=15, max_retries=1).models.list(limit=1)
    print("ok")
except anthropic.AuthenticationError:
    print("rejected: ANTHROPIC_API_KEY in .env is invalid or revoked")
except Exception as e:
    print(f"unreachable: {type(e).__name__} (no internet?)")
PY
)
[[ "$KEYCHECK" == ok ]] || die "Anthropic API key check failed: ${KEYCHECK:-could not run the check} (fix ANTHROPIC_API_KEY in .env)"
mkdir -p data

# Stop anything left over from an earlier run, so the port and the URL are ours.
pkill -f "uvicorn main:app" 2>/dev/null
pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null
rm -f data/phone_url.txt
sleep 1

PIDS=()
cleanup() {
  echo; c 33 "Stopping backend, tunnel and caffeinate…"
  rm -f data/phone_url.txt   # the URL dies with the tunnel; the HUD stops showing its QR
  kill "${PIDS[@]}" 2>/dev/null; wait 2>/dev/null; exit 0
}
trap cleanup INT TERM

# A fresh access key every run: only phones that scan this run's QR can get in through the tunnel.
ACCESS_KEY=$(backend/.venv/bin/python -c "import secrets; print(secrets.token_urlsafe(12))")
c 36 "▶ Starting backend on :$PORT"
JARVIS_ACCESS_KEY="$ACCESS_KEY" backend/.venv/bin/uvicorn main:app --app-dir backend --host 0.0.0.0 --port $PORT > data/backend.log 2>&1 &
PIDS+=($!)
for _ in $(seq 40); do curl -sf -o /dev/null "localhost:$PORT/latest" && break; sleep 0.25; done
curl -sf -o /dev/null "localhost:$PORT/latest" || die "Backend didn't start. See data/backend.log"

if (( KEEP )); then c 36 "▶ Keeping memory ($(curl -s localhost:$PORT/log | grep -o '"id"' | wc -l | tr -d ' ') frames)"
else curl -sf -X POST "localhost:$PORT/reset" >/dev/null && c 36 "▶ Memory cleared"; fi

# Cloudflare's quick-tunnel API sometimes times out: retry up to 3 times.
URL=""; TUNNEL=""
for attempt in 1 2 3; do
  c 36 "▶ Starting tunnel (attempt $attempt)"
  cloudflared tunnel --url "http://localhost:$PORT" > data/tunnel.log 2>&1 &
  TUNNEL=$!
  for _ in $(seq 60); do
    URL=$(grep -v api.trycloudflare data/tunnel.log | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | head -1)
    [[ -n "$URL" ]] && break
    kill -0 "$TUNNEL" 2>/dev/null || break      # cloudflared gave up (e.g. API timeout)
    sleep 0.5
  done
  [[ -n "$URL" ]] && break
  kill "$TUNNEL" 2>/dev/null; c 33 "  tunnel failed: $(grep -m1 -i 'failed' data/tunnel.log | cut -c1-120)"
  sleep 2
done
if [[ -z "$URL" ]]; then
  kill "${PIDS[@]}" 2>/dev/null
  die "No tunnel after 3 tries. Check the internet/hotspot; see data/tunnel.log"
fi
PIDS+=("$TUNNEL")
PHONE_URL="$URL/capture.html?k=$ACCESS_KEY"
printf '%s' "$PHONE_URL" > data/phone_url.txt   # the HUD turns this into a QR code

# The Mac's own DNS often caches a miss for brand-new names, so check through 1.1.1.1.
HOST=${URL#https://}; ok=0
for _ in $(seq 30); do
  IP=$(dig +short @1.1.1.1 "$HOST" 2>/dev/null | head -1)
  if [[ -n "$IP" ]] && [[ $(curl -s -o /dev/null -w '%{http_code}' -m 5 --resolve "$HOST:443:$IP" "$PHONE_URL") == 200 ]]; then ok=1; break; fi
  sleep 2
done

caffeinate -dimsu & PIDS+=($!)
# Reuse an open HUD tab (reload it) instead of stacking duplicates that fight over the mic.
found=$(osascript 2>/dev/null <<OSA
tell application "Google Chrome"
  set n to 0
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t starts with "http://localhost:$PORT" then
        if n is 0 then
          reload t
        else
          close t
        end if
        set n to n + 1
      end if
    end repeat
  end repeat
  return n
end tell
OSA
)
[[ "${found:-0}" -gt 0 ]] || open -a "Google Chrome" "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT"

echo
c "1;32" "  iPhone →  $PHONE_URL"
backend/.venv/bin/python -c "import segno,sys; segno.make(sys.argv[1], error='m').terminal(compact=True)" "$PHONE_URL" 2>/dev/null
c 2 "  (the same QR is on the HUD; press Q there to show it big)"
c 2 "  Locked: only phones that scan this QR can connect (a new key every run)"
(( ok )) || c 33 "  (tunnel not answering yet; wait ~30s, then refresh on the phone)"
printf '%s' "$PHONE_URL" | pbcopy 2>/dev/null && echo "  (copied to clipboard: AirDrop or text it to the phone)"
echo
c 2 "  Talk: phone is hands-free (\"Jarvis, …\") after the first tap · HUD: hold Space (M = hands-free)"
c 2 "  Checklist: iPhone Auto-Lock → Never · ⌃⌘F full screen · Q phone QR · V laptop audio · R clears memory"
c 2 "  Mac stays awake until Ctrl-C. Logs: data/backend.log, data/tunnel.log"
echo

# Stay up; if the backend or tunnel dies mid-demo, say so loudly.
while sleep 5; do
  kill -0 "${PIDS[0]}" 2>/dev/null || { c 31 "✗ BACKEND DIED: rerun scripts/demo.sh --keep"; tail -5 data/backend.log; break; }
  kill -0 "${PIDS[1]}" 2>/dev/null || { c 31 "✗ TUNNEL DIED: rerun scripts/demo.sh --keep (new URL)"; break; }
done
cleanup
