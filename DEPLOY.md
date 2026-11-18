# Deploying J.A.R.V.I.S. on Railway

The public deployment lets anyone try Jarvis from their own laptop and phone, with no tunnel
and no Mac. It runs the same app in **public mode** (`JARVIS_PUBLIC=1`, set by the
`Dockerfile`).

## How it works for a visitor

1. They open `https://<your-app>.up.railway.app` on a laptop. That's the HUD.
2. The HUD shows a QR code. They scan it with their phone, which joins **their** session.
3. They walk around, then ask "Jarvis, where did I leave my…?"

Each visitor gets a private **room**: their own photos, registered items and answers. Rooms
are tied to a cookie. Nobody can see anyone else's photos, and a room is deleted (photos too)
after 60 minutes idle, or 10 minutes if it never got a photo.

## One-time setup

1. **Anthropic key with a spend limit.** Create a separate API key just for this deployment,
   and set a monthly spend limit for it in the Anthropic console. The app also caps itself
   (below), but the console limit is the backstop that can't be bypassed.
2. **Railway project.** railway.com → New Project → Deploy from GitHub repo → pick this repo.
   Railway finds `railway.json` and builds the `Dockerfile`.
3. **Variables** (service → Variables):
   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | the key from step 1 (required) |
   | `JARVIS_DAILY_BUDGET_USD` | `2.00` (default): all visitors together, per UTC day |
   | `JARVIS_ROOM_BUDGET_USD` | `0.25` (default): one visitor, per day |
   | `JARVIS_ACCESS_KEY` | optional: makes the whole site private (see below) |
4. **Volume** (service → Settings → Volumes → New volume): mount path **`/data`**, 1 GB is
   plenty. Without it, rooms and the day's spend reset on every deploy (the budget counter
   resetting is the part that matters).
5. **Domain** (service → Settings → Networking → Generate domain). The app picks it up from
   `RAILWAY_PUBLIC_DOMAIN` for the QR links. A custom domain: set `JARVIS_PUBLIC_URL=https://…`.
6. **Memory:** Whisper `base.en` + the app use ~700 MB. Make sure the plan allows ~1 GB.

Deploys then happen on every push to the branch Railway watches.

## What protects it

| Threat | Protection | Where |
|---|---|---|
| Someone runs up your Anthropic bill | Daily cap ($2) for everyone, plus $0.25 per visitor; Jarvis says "I've reached my thinking allowance for today" instead of calling Claude. Spend is priced from each response's token usage and saved to the volume | `backend/budget.py` |
| Spamming expensive calls | Per-visitor limits per endpoint: 30 photos/min, 12 questions/min, 30 voice clips/min, … | `ROUTE_LIMITS` in `backend/main.py` |
| Flooding the server | 60 requests/s per IP; max 200 open connections; voice transcription 2 at a time | `PER_IP`, Dockerfile |
| Creating endless sessions | 10 new rooms per IP per hour, 40 rooms max (then "attending to other guests"), bots and crawlers never create one | `NEW_ROOMS_PER_IP`, `JARVIS_MAX_ROOMS` |
| Filling the disk | 400 photos and 12 items per room; idle rooms deleted; uploads capped (3 MB photo, 1 MB audio, 6 MB request); only real JPEG/PNG accepted | `backend/store.py`, `_read_image` |
| Seeing someone else's photos | Rooms are private; photo URLs only resolve inside your own room; room ids are 192-bit random | `backend/store.py` |
| Spoofing an IP to dodge limits | The IP is the last `X-Forwarded-For` hop (Railway's), not the forgeable first one | `_client_ip` |
| Other sites acting as a visitor (CSRF) | POSTs with a foreign `Origin` are refused; cookies are `SameSite=Lax`, `HttpOnly`, `Secure` | `_cross_site` |
| XSS, clickjacking, link leaks | Strict Content-Security-Policy (own scripts only), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` (the join link never leaks), HSTS | `SECURITY_HEADERS` |
| Poking around the API | `/docs` and `/openapi.json` are off; no server header; huge text fields rejected | `main.py` |
| A compromised process | Runs as an unprivileged user; one worker; no secrets in the image (`.dockerignore`) | `Dockerfile` |

**Know the limits:** anyone who sees the HUD's QR code (e.g. on a projector) can join that
room while it's up, same as before. Rate limits and rooms live in memory, so there's exactly one
replica; don't scale it out.

## Private instead of public

Set `JARVIS_ACCESS_KEY` to a long random string (`python3 -c "import secrets;print(secrets.token_urlsafe(24))"`).
Then only links with `?k=<key>` get in (once per browser, then a cookie remembers it), and
everyone else sees "Access denied". Rooms still keep each person's data separate.

## Tuning (all optional variables)

| Variable | Default | Meaning |
|---|---|---|
| `JARVIS_MAX_ROOMS` | 40 | rooms alive at once |
| `JARVIS_ROOM_TTL_MIN` | 60 | idle minutes before a room is deleted |
| `JARVIS_MAX_FRAMES` / `JARVIS_MAX_ITEMS` | 400 / 12 | per room |
| `JARVIS_MAX_LOG_ENTRIES` | 200 | captions sent with each question (lower = cheaper answers) |
| `JARVIS_STT_CONCURRENCY` | 2 | voice clips transcribed at once |
| `ELEVENLABS_API_KEY` | unset | the ElevenLabs voice instead of Piper. It costs credits per answer |
| `JARVIS_PIPER_VOICE` | `/opt/piper/en_GB-alan-medium.onnx` | Jarvis's free voice (Piper, baked into the image). Another British male option: `en_GB-northern_english_male-medium` (download it into `/data/piper` with `python -m piper.download_voices`) |

Whisper model: for better accuracy in noise, set the service variable `STT_MODEL=small.en`
(Railway passes it to the Dockerfile's `ARG STT_MODEL`) and redeploy. It needs ~1 GB more RAM.

## Check it

```bash
curl https://<your-app>.up.railway.app/healthz            # {"ok":true}
backend/.venv/bin/python scripts/smoke.py --url https://<your-app>.up.railway.app
```

The smoke test gets its own fresh room, so it never touches a visitor's data. It makes real
Claude calls (a few cents, counted against the daily budget).

The HUD's `/health` reply includes `budget`: today's spend and the caps.

## Run public mode locally

```bash
docker build -t jarviswims . && docker run --rm -p 8000:8000 -e ANTHROPIC_API_KEY -e JARVIS_PUBLIC_URL=http://localhost:8000 jarviswims
```

The phone can't use the camera over plain `http://` to your laptop's IP, so test the phone
side on the real Railway URL.
