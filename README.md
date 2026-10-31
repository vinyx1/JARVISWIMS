# Untitled ghost project 👻 (name TBD)

The ghost of your last 10 minutes. Wear your phone, walk around, then ask
"where's my jacket?" or "retrace my steps."

See `CLAUDE.md` for team rules and ownership, and `API.md` for the contract.

## Run locally

```bash
cp .env.example .env            # add your ANTHROPIC_API_KEY
cd backend
uv venv && source .venv/bin/activate
uv pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 on your laptop.

## Run on a phone (needs HTTPS for the camera)

```bash
brew install ngrok   # one time; then `ngrok config add-authtoken <token>`
ngrok http 8000
```

Open the `https://…ngrok…` URL on the phone.

## Demo tips

- Use a phone hotspot instead of venue Wi-Fi.
- `POST /reset` before each run.
- Keep the page in the foreground. It requests a wake lock so the screen stays on.
