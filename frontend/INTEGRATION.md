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

## Selected-object outline

The selected “LAST SEEN” photo now accepts an optional `box` field on its `/ask` frame entry:

```json
{"id":"f_000101","url":"/frames/f_000101.jpg","ts":1730400000000,"note":"Helmet on chair","box":[0.35,0.45,0.65,0.85]}
```

`box` is exactly Kenny's `ai.locate_object(jpeg, item)` return format: normalized `[x0, y0, x1, y1]`, top-left to bottom-right, each in 0–1. The selected frame is first for `find`, last for `retrace`. The UI draws one gold rectangle over that source photo, preserving alignment with `object-fit: contain` and any letterboxing. It does not draw the historical box over a different live frame.

**Backend handoff (Vince/Paul):** after selecting the evidence frame, locate the requested item in that frame's JPEG and attach the returned array as its `box`. If localization fails, times out, is unsupported or returns null, omit the field or set it to null. Do not block an otherwise usable text/photo answer on localization. This field is a proposed response extension documented here; shared API.md is unchanged pending team agreement. The existing merged `locate_object` helper is not yet invoked by `/ask`, so the production outline remains unavailable until this handoff is connected.

Missing/malformed/degenerate/out-of-range coordinates hide the outline while the answer/photo still work. New queries and reset immediately clear it. It renders only once the corresponding image has loaded, and image failure clears it. Source-image pixel dimensions determine the SVG viewBox; no frontend estimation of an object's location is performed.

Verification: `node --test frontend/test/*.test.mjs` includes normalized-box validation. `hud-browser.cjs` checks the selected box at desktop, small-laptop and narrow sizes, plus absent/invalid boxes and cleanup. Synthetic coordinates verify rendering; actual model localization quality requires a real image and authorized backend call on the demo machine.

## Round 2 frontend (TASKS.md)

Synced with `c60724b` and the updated API. `kind: "remember"` is accepted and displays a gold `REGISTERED · MY <ITEM>` heading. The item name is resolved from the matching `GET /mine` record; while the list is loading, the heading says `MY ITEM`. Registration shows no route strip. My Items loads on startup, after remember, after reset, and after page restoration; generation guards prevent old responses from restoring cleared entries.

A find answer with multiple valid frames now shows side-by-side candidate buttons. Choosing one updates the main evidence photo and its optional object outline; these are alternatives, not a walking route. Retrace keeps its ordered breadcrumbs.

Phone preview sends 360px JPEGs at quality .45 every 100ms, with at most three encode/upload slots and a two-second upload timeout. Each request carries `ts`; the backend rejects older arrivals. Stop/page hide aborts pending preview requests and invalidates pending encodes. The captioned capture loop remains independent at three seconds. The HUD polls preview serially every 70ms while live, so GET responses cannot race each other. No claim of 10+ real FPS is made until testing the iPhone/tunnel.

`node frontend/test/phone-preview.cjs` (same Playwright/Chrome requirements) verifies timestamped bounded concurrency, image size/quality and Stop using a synthetic camera and delayed requests. The HUD test also checks remember, My Items refresh and candidate selection. No provider key is needed for these tests.
