# J.A.R.V.I.S. (project name TBD)

Dress as Iron Man, hold up your phone, walk around, then say
**"Jarvis, where did I leave my helmet?"**

See `CLAUDE.md` for the plan, roles and rules, and `API.md` for the contract.

## Setup (each teammate, once)

```bash
brew install uv                  # if missing
git clone https://github.com/vinyx1/hackathon-to-be-decided.git
cd hackathon-to-be-decided
cp .env.example .env             # paste the team's ANTHROPIC_API_KEY
cd backend && uv venv && uv pip install -r requirements.txt && cd ..
```

## Run the backend

```bash
backend/.venv/bin/uvicorn main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
```

The HUD is at http://localhost:8000.

## Fake a walk (no phone needed)

With the backend running, in a second terminal:

```bash
backend/.venv/bin/python scripts/replay.py --reset          # sends samples/*.jpg every 3s
backend/.venv/bin/python scripts/replay.py --every 1        # faster
```

`samples/` holds ~15 photos of the real demo route, in walking order (`01.jpg`, `02.jpg`, …).

## Run on the iPhone (Vince's laptop only; the camera needs HTTPS)

```bash
brew install cloudflared                              # once; no account needed
cloudflared tunnel --url http://localhost:8000
```

Open the printed `https://….trycloudflare.com/capture.html` on the iPhone in Safari.
The URL changes every time cloudflared restarts.

## Demo tips

- Use a phone hotspot instead of venue Wi-Fi.
- Press **R** on the HUD (or `POST /reset`) before each run.
- Keep the capture page in the foreground. It requests a wake lock so the screen stays on.
