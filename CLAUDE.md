# J.A.R.V.I.S. — Halloween hackathon (project name TBD)

Halloween hackathon, Oct 31 2026, **10:00am to 3:00pm**. The theme is a Halloween
character. Ours is **Jarvis from Iron Man**: you're dressed as Iron Man, and
Jarvis is your AI. Judging is on **creativity**, and the demo is **live**.

Someone holds an iPhone up while walking. It snaps a photo every ~3s. Claude
captions each frame. On the laptop (on the projector), a Jarvis heads-up display
shows what the phone sees in near-real time. You say **"Jarvis, where did I leave
my helmet?"** and Jarvis answers in a British voice, shows the photo where the
item was, and walks you back past the landmarks.

Read `API.md` for the frontend/backend contract and `README.md` for setup.

## Team and ownership — agents MUST respect this

| Person | Role | Files they may edit |
|---|---|---|
| Jogindar | A — frontend (laptop HUD + phone capture page) | `frontend/**` |
| Vince | B — backend, ngrok, demo server | `backend/main.py`, `backend/store.py`, `backend/requirements.txt` |
| Kenny | C — AI: captions, answers, Jarvis's personality, demo script | `backend/ai.py`, `prompts/**` |

- Only edit files you own. If you need a change elsewhere, stop and tell your
  human so they can ask the owner.
- `API.md` and `CLAUDE.md` are shared. Do not change them without the team agreeing.
  If the contract changes, update `API.md` in the same commit.

## Product decisions (settled)

- **Two pages, one backend:**
  - **Phone capture page** (`frontend/capture.html`): iPhone Safari. Camera view,
    one big Start button, an upload every 3s, and a wake lock. Nothing else.
  - **Laptop HUD** (`frontend/index.html`): Chrome on the Mac, on the projector.
    Polls `GET /latest` about once a second and shows the newest frame full screen
    with an Iron Man-style overlay: corner brackets, "SCANNING", the room guess,
    and object labels. When a question is answered, it shows Jarvis's reply, the
    matching photo, and a breadcrumb strip.
- **Voice input: wake word "Jarvis".** The laptop listens all the time (Chrome
  `webkitSpeechRecognition`, continuous, restarted on `onend`). When a final
  transcript starts with "jarvis", send the rest to `POST /ask`. Keep a typed
  input box as a fallback.
- **Voice output:** browser `speechSynthesis` with a British voice (prefer
  "Daniel"; otherwise any `en-GB` voice). No paid text-to-speech service.
- **Hero feature: find a lost item.** Retrace (walking back past landmarks) is
  the follow-up line in the same answer. It is cut first under time pressure.
- **Personality:** dry, polite, British butler-AI. "Sir…", "Very good, sir."
  Short replies of 2–3 sentences. Never call it a ghost.
- **Hosting:** only **Vince's laptop** runs the backend and the HUD, exposed with
  `ngrok http 8000` so the iPhone can open the camera over HTTPS. Use a phone
  hotspot, not venue Wi-Fi. During development, everyone runs their own backend locally.
- **Live demo (~60s, rehearsed):** start capture, walk past 2–3 distinctive
  landmarks, put the Iron Man helmet (or a jacket) down, walk back to the stage,
  then say "Jarvis, where did I leave my helmet?"

## Tech choices (keep it boring)

- Backend: Python 3.11+, FastAPI, Anthropic SDK. It also serves `frontend/` as static files.
- Frontend: plain HTML/JS/CSS. No build step and no framework.
- Storage: JPEGs in `data/frames/` and one append-only `data/log.jsonl`. No database.
- Models: `claude-haiku-5-5` for per-frame captions, `claude-sonnet-5-5` for answers.

## Schedule (hard checkpoints)

| Time | Checkpoint |
|---|---|
| 10:15 | Skeleton updated and pushed. Everyone clones, creates `.env`, and branches |
| 11:30 | Real captions (Kenny). HUD with live feed (Jogindar). `/latest`, ngrok and the iPhone capture page working (Vince) |
| 12:30 | **Full end-to-end test**: walk, "Jarvis, …", answer with photo and voice. Anything not working is cut |
| 1:30 | Tune prompts on photos from the real demo route. HUD polish. Stretch goal only if everything works |
| 2:15 | **Code freeze.** 2–3 full rehearsals. Record a backup video |
| 3:00 | Present |

## Scope priority (cut from the bottom)

1. Capture, caption, and "Jarvis, where's my X?" answered with a photo
2. Laptop HUD with live feed and overlay
3. Voice: wake word in, British voice out (typed fallback)
4. Retrace narrative past landmarks
5. **Stretch:** Jarvis comments on his own every so often ("Sir, that's your third pass of the snack table")
6. Frame dedup, GPS/compass

## Still undecided

- Project/submission name. Candidates: "Jarvis, Where's My Helmet?", "J.A.R.V.I.S. Lost & Found Protocol".
- `prompts/` and `README.md` still use the old ghost persona. Kenny rewrites the prompts as Jarvis.

## Git rules

- Never commit directly to `main`. Work on a branch: `frontend/<task>`,
  `backend/<task>`, or `ai/<task>`.
- Before starting a task: `git checkout main && git pull && git checkout -b <branch>`.
- Keep branches small and merge within ~45 minutes: open a PR and squash-merge.
- Never force-push to `main`. Never commit `.env`, `data/`, or API keys.
- If you run two agents at once, give each its own `git worktree`.
