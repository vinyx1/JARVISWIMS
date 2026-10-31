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
