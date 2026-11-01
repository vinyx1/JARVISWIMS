#!/usr/bin/env bash
# One command for stage setup. Owner: Vince (B).
#   scripts/demo.sh          start backend + tunnel, clear memory, keep the Mac awake, open the HUD
#   scripts/demo.sh --keep   same, but keep the current memory (e.g. restarting mid-demo)
# Ctrl-C stops everything. Logs: data/backend.log, data/tunnel.log
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=8000
KEEP=0; [[ "${1:-}" == "--keep" ]] && KEEP=1
c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }   # c <color> <text>
die() { c 31 "✗ $1"; exit 1; }

[[ -x backend/.venv/bin/uvicorn ]] || die "No backend venv. See README.md setup."
[[ -f .env ]] && grep -q '^ANTHROPIC_API_KEY=sk' .env || die "No ANTHROPIC_API_KEY in .env"
# A revoked or mistyped key doesn't crash anything: every caption just turns into "unclear frame".
# So prove it works now, with one tiny real call.
KEYCHECK=$(backend/.venv/bin/python - <<'PY' 2>&1
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
[[ "$KEYCHECK" == ok ]] || die "Anthropic API key check failed: $KEYCHECK"
command -v cloudflared >/dev/null || die "cloudflared missing: brew install cloudflared"
mkdir -p data

# Stop anything left over from an earlier run, so the port and the URL are ours.
pkill -f "uvicorn main:app" 2>/dev/null
pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null
sleep 1

PIDS=()
cleanup() {
  echo; c 33 "Stopping backend, tunnel and caffeinate…"
  kill "${PIDS[@]}" 2>/dev/null; wait 2>/dev/null; exit 0
}
trap cleanup INT TERM

c 36 "▶ Starting backend on :$PORT"
backend/.venv/bin/uvicorn main:app --app-dir backend --host 0.0.0.0 --port $PORT > data/backend.log 2>&1 &
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

# The Mac's own DNS often caches a miss for brand-new names, so check through 1.1.1.1.
HOST=${URL#https://}; ok=0
for _ in $(seq 30); do
  IP=$(dig +short @1.1.1.1 "$HOST" 2>/dev/null | head -1)
  if [[ -n "$IP" ]] && [[ $(curl -s -o /dev/null -w '%{http_code}' -m 5 --resolve "$HOST:443:$IP" "$URL/capture.html") == 200 ]]; then ok=1; break; fi
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
c "1;32" "  iPhone →  $URL/capture.html"
command -v qrencode >/dev/null && qrencode -t ansiutf8 "$URL/capture.html"
(( ok )) || c 33 "  (tunnel not answering yet; wait ~30s, then refresh on the phone)"
printf '%s' "$URL/capture.html" | pbcopy 2>/dev/null && echo "  (copied to clipboard: AirDrop or text it to the phone)"
echo
c 2 "  Checklist: iPhone Auto-Lock → Never · click the HUD once (mic + voice) · ⌃⌘F full screen · R clears memory"
c 2 "  Mac stays awake until Ctrl-C. Logs: data/backend.log, data/tunnel.log"
echo

# Stay up; if the backend or tunnel dies mid-demo, say so loudly.
while sleep 5; do
  kill -0 "${PIDS[0]}" 2>/dev/null || { c 31 "✗ BACKEND DIED: rerun scripts/demo.sh --keep"; tail -5 data/backend.log; break; }
  kill -0 "${PIDS[1]}" 2>/dev/null || { c 31 "✗ TUNNEL DIED: rerun scripts/demo.sh --keep (new URL)"; break; }
done
cleanup
