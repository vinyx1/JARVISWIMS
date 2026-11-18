# JARVIS: Where Is My Stuff? (JARVISWIMS)

Built for Hack or Treat 2026

**Devpost:** https://devpost.com/software/jarvis-where-is-my-stuff

Everyone loses their keys, AirPods or wallet, and the usual fix
(retracing your steps, hoping you remember) doesn't work. JARVIS remembers for you.

Carry your phone with its camera on as you move around. Jarvis will record your surroundings, noting down objects it sees and learns which ones are yours. When something goes missing, just ask:

> **"Jarvis, where did I leave my keys?"**

He answers out loud, shows you the photo of where he last saw them, and guides you back past the
landmarks you walked by. Tell him "I'm leaving my AirPods here" and he saves the spot. If he
hasn't seen them yet, he keeps looking and speaks up as soon as they appear on camera.

**Try it live:** https://jarvis-wheres-my-stuff.up.railway.app (open it on a laptop, scan the QR with your phone)

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

## Try it

| | Where | Needs |
|---|---|---|
| **Online** | https://jarvis-wheres-my-stuff.up.railway.app (to host your own, see [DEPLOY.md](DEPLOY.md)) | a laptop browser + a phone |
| **On a Mac** | `./start`, below | macOS, an Anthropic API key, an iPhone |
| **Without a phone** | `./start` + `scripts/replay.py` (a fake walk from `samples/`) | macOS, an API key |

### Run it on your Mac

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