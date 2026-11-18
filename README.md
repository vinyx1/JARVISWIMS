# JARVIS: Where Is My Stuff? (JARVISWIMS)

**A memory for your things.** Everyone loses their keys, AirPods or wallet, and the usual fix
(retracing your steps, hoping you remember) doesn't work. JARVIS remembers for you.

Carry your phone with its camera on as you move around. Jarvis watches quietly, notes what he
sees and where, and learns which things are yours. When something goes missing, just ask:

> **"Jarvis, where did I leave my keys?"**

He answers out loud, shows you the photo of where he last saw them, and guides you back past the
landmarks you walked by. Tell him "I'm leaving my AirPods here" and he saves the spot. If he
hasn't seen them yet, he keeps looking and speaks up as soon as they appear on camera.

It's Tony Stark's AI butler for the rest of us: hands-free, polite, very British, and running
on a phone and a laptop.

**Devpost:** https://devpost.com/software/jarvis-where-is-my-stuff

Built at a Halloween hackathon (Oct 31, 2026), where the theme was dressing up as a character.
We went as Iron Man, so the demo is: put down the helmet, walk away, and ask Jarvis to find it.

## How it works

```
 iPhone (camera)           Server (FastAPI)                         Laptop (HUD)
 a photo every ~3 s  ──▶   Claude Haiku captions each photo   ◀──   hologram Jarvis, live view
 "Jarvis, where's…?" ──▶   Whisper hears it, Claude Sonnet    ──▶   answer + the photo of
                           answers from the caption log             where he saw it
```

1. The **phone** is the camera. It sends a photo every few seconds and listens for "Jarvis".
2. **Claude Haiku 5.5** captions every photo in the background: the room, the objects, the landmarks.
3. You **teach Jarvis your things**: "Jarvis, this is my AirPods, remember it." He studies them
   (description, distinguishing marks, a close-up) so he recognises them later.
4. You ask. **Whisper** (running on the server, free and offline) turns speech into text, and
   **Claude Sonnet 5.5** answers from the captions. For your registered items, it takes a second
   look at the photos since they were last seen.
5. The **HUD** on the laptop shows Jarvis reacting (listening, thinking, answering), the photo
   of where your item is, and the walk back past landmarks.

## Try it

| | Where | Needs |
|---|---|---|
| **Online** | the Railway deployment (see [DEPLOY.md](DEPLOY.md) to host your own) | a laptop browser + a phone |
| **On a Mac** | `./start`, below | macOS, an Anthropic API key, an iPhone |
| **Without a phone** | `./start` + `scripts/replay.py` (a fake walk from `samples/`) | macOS, an API key |

### Run it on your Mac (one command)

```bash
git clone https://github.com/vinyx1/JARVISWIMS.git
cd JARVISWIMS
./start
```

Or double-click **`Start Jarvis.command`** in Finder. The first run installs what it needs
(uv, cloudflared, the Python packages, Whisper's ~480 MB speech model) and asks for your
Anthropic API key. Every run then:

1. checks the API key actually works,
2. starts the server and a fresh HTTPS tunnel for the iPhone (its camera only works over HTTPS),
3. opens the HUD in Chrome with a **QR code**: scan it with the iPhone and tap **Begin**.

`./start --keep` restarts without clearing Jarvis's memory. Ctrl-C (or closing the window) stops
everything. `./start` needs macOS and [Homebrew](https://brew.sh); on Linux or Windows, use the
Docker image from [DEPLOY.md](DEPLOY.md) or the manual setup below.

### Put it online

Push this repo to Railway and it builds the `Dockerfile` in **public mode**: each visitor gets a
private session, with rate limits, upload caps and a $2/day AI budget. Every step and every
protection is in **[DEPLOY.md](DEPLOY.md)**.

## Using it

**Talking to Jarvis**
- On the phone: say **"Jarvis, …"** any time (hands-free), or hold anywhere on the screen and speak.
- On the HUD: **hold Space** and speak, or press **Enter** to type.

**Things to say**
| Say | What happens |
|---|---|
| "Jarvis, this is my AirPods, remember it" | registers the item from the camera view |
| "Jarvis, I'm leaving my AirPods here" | saves the spot as where it is now |
| "Jarvis, where are my AirPods?" | the answer + the photo where he last saw it |
| "Jarvis, where did I leave my helmet?" | works for anything he has seen, registered or not |

If none of the photos he shows is right, close them and he keeps looking. He'll speak up
when it turns up on camera.

**HUD keys** (also under **Commands**, or press **?**)
| Key | Does |
|---|---|
| **H** | six-step guided walkthrough |
| **Space** (hold) | talk |
| **Enter** | type a question |
| **V** | laptop audio on/off (phone audio is on by default) |
| **Q** | show the phone QR big |
| **D** | debug view: live camera, captions, chat, possible matches, MY ITEMS |
| **R** | clear Jarvis's memory (do it before every demo) |

The HUD opens with an intro: click **Engage** (that click also unlocks audio). Play with the
core: hover to draw constellations, click to drop nodes, drag to spin the rings, double-click
to overcharge it.

## Good to know

- **It costs a little.** Every photo and question is a Claude call on your API key: by our
  estimate, around 10 to 20 cents for a 10-minute walk with a few questions. The public deployment caps itself at $2/day; on your own key,
  set a spend limit in the [Anthropic console](https://console.anthropic.com) too.
- **Privacy.** Photos are sent to Anthropic's API to be captioned and are stored only on the
  server running Jarvis (your Mac, or the Railway volume). Online, each visitor's photos are
  private to their session and deleted after 60 minutes idle.
- **The QR code is the key.** Locally, each `./start` makes a new random key and builds it into
  the QR; anyone without it gets "Access denied". But anyone who scans the QR while it's on
  screen (a projector!) gets in. It hides once the camera feed starts.
- **Browsers.** Built and tested with Chrome on a Mac (HUD) and Safari on an iPhone (phone).
- **Better voice (free, Mac).** System Settings → Accessibility → Spoken Content → System voice
  → Manage Voices → English (UK) → download **Daniel (Enhanced)**, then restart `./start`.
  Optional: an `ELEVENLABS_API_KEY` in `.env` gives him an ElevenLabs voice.
- **Live demo tips.** Use a phone hotspot rather than venue Wi-Fi, press **R** before each run,
  set iPhone Auto-Lock to Never, and keep the phone page in front (it holds a wake lock).

## Development

**Manual setup**

```bash
brew install uv                  # or: curl -LsSf https://astral.sh/uv/install.sh | sh
cp .env.example .env             # add your ANTHROPIC_API_KEY
uv venv backend/.venv && uv pip install --python backend/.venv/bin/python -r backend/requirements.txt
backend/.venv/bin/uvicorn main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
```

The HUD is at http://localhost:8000. For the phone, run `cloudflared tunnel --url http://localhost:8000`
and open the printed `https://….trycloudflare.com/capture.html` in Safari.

**Fake a walk (no phone):** with the server running, in a second terminal:

```bash
backend/.venv/bin/python scripts/replay.py --reset          # sends samples/*.jpg every 3 s
```

`ECHO_STUB_AI=1` in the server's environment returns fake captions, so you can work on the UI
with no API key or cost.

**Tests**

```bash
backend/.venv/bin/python -m pytest tests                    # backend
node --test frontend/test/*.test.mjs                        # frontend
backend/.venv/bin/python scripts/smoke.py --url http://localhost:8010   # end to end
```

The smoke test resets the server it tests, so point it at a spare one
(`JARVIS_DATA=/tmp/jarvis-smoke … --port 8010`), never the demo. It also runs on every PR.

**Where things are**

| Path | What |
|---|---|
| `backend/main.py` | the API, rooms, security (rate limits, caps, headers) |
| `backend/ai.py` · `prompts/caption.md` | Jarvis's eyes: captions, studying items, second looks |
| `backend/answer.py` · `prompts/answer.md` | Jarvis's brain: answers and personality |
| `backend/stt.py` · `backend/voice.py` | ears (Whisper) and voice (ElevenLabs / Mac voice) |
| `backend/store.py` · `backend/budget.py` | photo storage per session · the daily AI budget |
| `frontend/index.html` · `capture.html` | the HUD · the phone page |
| `API.md` · `CLAUDE.md` · `DEPLOY.md` | the API contract · project notes · hosting it |
| `samples/` | photos of the demo route, for fake walks and tests |
