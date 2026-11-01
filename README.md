# J.A.R.V.I.S. (project name TBD)

Dress as Iron Man, hold up your phone, walk around, then say
**"Jarvis, where did I leave my helmet?"**

See `CLAUDE.md` for the plan, roles and rules, and `API.md` for the contract.

## Quick start (one command)

```bash
./start
```

Or double-click **`Start Jarvis.command`** in Finder. The first run installs what it needs
(uv, cloudflared, Python packages) and asks for your Anthropic API key. Every run then:

1. checks the API key actually works,
2. starts the backend and a fresh HTTPS tunnel for the iPhone,
3. opens the HUD in Chrome, showing a **QR code**: scan it with the iPhone camera, tap
   Start on the page that opens. The same QR prints in the terminal; press **Q** on the HUD
   to show it big at any time.

**Locked to your QR:** each `./start` makes a new random key and builds it into the QR link.
Only phones that scan it can use the app through the tunnel; anyone else with the bare link
gets "Access denied". The HUD on the laptop needs no key. Mind that the QR on the projector is
the key: anyone who scans it while it's up gets in (it hides once the camera feed starts).

`./start --keep` restarts without clearing memory. Ctrl-C (or closing the window) stops it.
**The phone** is just the camera: tap **Begin** (it asks for the camera, then the microphone),
then say "Jarvis, …" any time; a Siri-style Jarvis slides up with your question and his answer.
Hold anywhere on the screen to talk without saying "Jarvis". The old phone controls (camera
picker, typed questions, audio switch) are at `/capture-debug.html`. On the HUD, **hold Space** and speak. **Audio:** every device with its audio on speaks every answer. Phone audio is on
by default (switch on the capture page); laptop audio is off by default (**V**). Speech is
transcribed on the laptop by Whisper (offline, free); the first run downloads its model (~480 MB).

**Finding your own things:** "Jarvis, this is my AirPods, remember it" registers them. When you
put them down, say **"Jarvis, I'm leaving my AirPods here"**: he saves the spot from the camera.
Later, "where are my AirPods?" answers from that spot (or a newer sighting), however long ago.
The HUD's MY ITEMS shows where each was last seen.

**The HUD** (`localhost:8000`) opens with an intro that waits on **Engage** (click it, or press
Enter; any key fast-forwards the intro, and that click also unlocks audio). Then it shows Jarvis as a
hologram core that reacts like Siri: amber when he hears "Jarvis", spinning up while he thinks,
pulsing while he answers, with the photo of where he saw your item. **D** switches to the debug
view (`/debug.html`: live camera, what he sees, chat, possible matches, MY ITEMS) and back.
The previous HUD is also saved as the git tag `ui-classic`.

**Walkthrough:** press **H** (or **How it works** on the HUD) for a six-step guided demo: scan the
QR, look around, teach him your things, tell him where you put one, go about your day, ask.
← → or Back/Next step through it.
Play with the core: hover to draw a constellation, click to drop linked nodes, drag to spin the
rings, double-click to overcharge it.
Laptop audio: click the **audio** gauge (bottom right), or press **V**.
HUD keys: **H** walkthrough · **Space** (hold) talk · **V** laptop audio on/off · **Enter** type a question ·
**Q** phone QR · **D** debug view · **R** clear memory. Hands-free listening is on the phone.

**Better voice (free):** System Settings → Accessibility → Spoken Content → System voice →
Manage Voices → English (UK) → download **Daniel (Enhanced)**. Restart `./start`; Jarvis uses it
automatically.

## Manual setup (development)

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

## Smoke test (before and after every merge)

```bash
backend/.venv/bin/python scripts/smoke.py           # PASS or FAIL, end to end
```

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
