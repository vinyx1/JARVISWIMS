# Frontend notes (Jogindar)

The product plan lives in the repo-root `CLAUDE.md`, and the contract in `API.md`. Follow those.
Calibration and angle/distance answers were dropped: the backend has no geometry and there
isn't time to add it. Answers are Jarvis's text plus evidence photos.

| File | What |
|---|---|
| `index.html`, `app.js`, `hud.css` | Laptop HUD on the projector: live feed via `/latest`, voice, answers + photos |
| `voice.js` | Wake word "Jarvis", hold-Space push-to-talk, British speech output |
| `capture.html`, `capture.js`, `style.css` | iPhone capture page (open via the cloudflared URL) |
| `api.js`, `core.js`, `camera.js` | Shared: API client with timeouts, capture loop, `/latest` poller, safe frame URLs |
| `test/core.test.mjs` | `node --test frontend/test/core.test.mjs` |

HUD keys: **Space** (hold) to talk, **R** to clear memory, **Esc** to hide the evidence panel.
Click anywhere once after loading: Chrome needs a gesture before the mic and speech start.

## No-key HUD QA

Run `node --test frontend/test/*.test.mjs` for capture/API and voice lifecycle tests.
Run `node frontend/test/hud-browser.cjs` with Playwright and installed Google Chrome while the app is served locally (defaults to port 8000; override with `HUD_URL`). `PLAYWRIGHT_MODULE` can point at an existing Playwright module. All API responses, image frames and speech APIs are mocked; no API key, real microphone or camera is used. Optional `SCREENSHOT_PATH` saves a clearly labeled synthetic-frame screenshot.

Covers pending captions, live-preview fallback, full text answers/evidence/breadcrumbs, errors, wake-word/PTT/TTS wiring, reset concurrency, page restoration, microphone denial and 1440/1280/1024/390px layouts. Real recognition, acoustic echo/noisy-venue behaviour, actual British voice availability, the phone and projector still need final testing on Vince's setup.

Before resetting memory, stop remote phone capture and let pending captions finish. The UI checks for pending captions, but the server still needs atomic session protection against captions from other clients arriving during reset.
