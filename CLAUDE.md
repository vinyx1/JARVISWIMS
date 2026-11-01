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

## Ownership

The hackathon team has disbanded; **Vince now owns the whole repo** and agents may edit any
file. The per-person split below is history, kept so the "Owner:" comments in files make sense.

| Person (former) | Role | Files |
|---|---|---|
| Jogindar | A — frontend (laptop HUD + phone capture page) | `frontend/**` |
| Vince | B — backend, tunnel, demo server | `backend/main.py`, `backend/store.py`, `backend/requirements.txt`, `scripts/**` |
| Kenny | C — AI eyes: per-frame captions, demo-route photos | `backend/ai.py`, `prompts/caption.md`, `samples/**`, `tests/real_log.json` |
| Paul | D — AI brain and voice: answers, Jarvis's personality, answer tests | `backend/answer.py`, `prompts/answer.md`, `tests/**` |

- If the contract changes, update `API.md` in the same commit.

## Architecture

```
 iPhone (Safari)                   Vince's laptop                          Projector
┌──────────────┐  POST /frame   ┌──────────────────────────────────┐
│ capture.html │── cloudflared ▶│ FastAPI (backend/main.py)        │
│ photo / 3s   │    (HTTPS)     │  ├ store.py → data/frames, log   │
└──────────────┘                │  ├ ai.py → Haiku captions (bg)   │
                                │  └ answer.py → Sonnet answers    │
 scripts/replay.py ─POST /frame▶│                                  │
 (fake walk from samples/)      │                                  │
                                │ Chrome: localhost:8000 (HUD) ◀───┼── GET /latest every 1s
                                │  mic → "Jarvis, …" → POST /ask   │──▶ mirrored to
                                │  speechSynthesis (Daniel)        │    projector
                                └──────────────────────────────────┘
```

## How we work in parallel (nobody waits on anybody)

`API.md` is the only thing we all depend on. **`samples/`** holds ~15 real
photos of the demo route, in walking order (`01.jpg`…), and
**`scripts/replay.py`** posts them to `/frame` every 3s to fake a walk.

- **Jogindar (HUD):** run the backend locally plus `replay.py`, and the HUD gets a
  live feed. You don't need the iPhone, real AI or the tunnel. The stub AI returns fake captions.
- **Kenny (AI):** tune the prompts by captioning `samples/` directly (write a
  small script that calls `ai.caption_frame` on each file and prints the JSON).
  You don't need the HUD or the server. Keep `ai.py`'s function signatures and return shapes.
- **Paul (AI):** tune answers without waiting for real captions. Hand-write a
  fake captioned log (`tests/fake_log.json`, ~15 entries of a walk with the
  helmet left on a chair) and a test script that asks 5–10 questions through
  `answer.answer()` and prints the replies. Later, rerun it on Kenny's real
  captions of `samples/`. Keep `answer()`'s signature and the `/ask` shape in `API.md`.
- **Vince (backend):** the real endpoints, the cloudflared tunnel, and the iPhone
  capture flow. You don't need finished prompts or the HUD.
- **Integration is just merging to `main`.** At 12:30, everything runs on Vince's laptop.

## Integration rules (so the pieces line up)

1. **Run the smoke test before and after merging to `main`.** It resets the server it
   tests, so run it against a spare server with its own data folder (see the top of
   `scripts/smoke.py`), never the demo server. It replays `samples/`, waits for captions,
   asks a question, and checks every response against `API.md`. **Don't merge if it
   prints FAIL**, and read any WARN: "the AI is failing" means a bad key or no network.
2. **Kenny → Paul handoff (the weakest seam).** Paul's prompt reads Kenny's
   captions, so the words must match: "helmet" in a caption, not "dark headgear".
   As soon as real captions work, Kenny commits them as `tests/real_log.json`
   (`curl localhost:8000/log > tests/real_log.json` after replaying `samples/`),
   and Paul tests on that instead of his hand-written log. Kenny: tell Paul
   whenever the caption prompt changes.
3. **Never crash on bad model output.** Claude occasionally returns malformed JSON.
   - Kenny: on a parse or API error, return a valid Caption
     (`{"scene": "unclear frame", "room_guess": "unknown", "objects": [], "landmarks": []}`).
   - Paul: on a parse or API error, return
     `{"answer": "I'm afraid the footage is unclear, sir.", "kind": "other", "frames": []}`.
4. **Paul only returns frame ids that exist in `log`.** Drop any others, and fill
   in `url` and `ts` from the log entry. The model only provides `id` and `note`.
   The smoke test checks this.

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
  transcript starts with "jarvis", send the rest to `POST /ask`. Fallbacks, in
  order: **hold the spacebar** to force-listen, then a typed input box. The venue will be loud.
- **Filler line:** the instant a question is heard, Jarvis says something like
  "Checking the footage, sir" and the HUD shows a scanning animation while
  `/ask` runs. If answers still take longer than ~5s at 12:30, switch answering to Haiku.
- **Captions run in the background:** `/frame` saves instantly, and the HUD shows
  the photo with "ANALYZING…" until the caption arrives (see `API.md`).
- **Hidden reset:** pressing **R** on the HUD calls `POST /reset` and clears the
  screen. Do it before every rehearsal, or Jarvis finds the helmet from the last run.
- **Voice output:** browser `speechSynthesis` with a British voice (prefer
  "Daniel"; otherwise any `en-GB` voice). No paid text-to-speech service.
- **Hero feature: find a lost item.** Retrace (walking back past landmarks) is
  the follow-up line in the same answer. It is cut first under time pressure.
- **Personality:** dry, polite, British butler-AI. "Sir…", "Very good, sir."
  Short replies of 2–3 sentences. Never call it a ghost.
- **Hosting:** only **Vince's laptop** runs the backend and the HUD, exposed with
  `cloudflared tunnel --url http://localhost:8000` (no account needed) so the
  iPhone can open the camera over HTTPS. The HUD itself uses `localhost:8000`. Use a phone
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
| 10:30 | Kenny has committed `samples/` (photos of the demo route) |
| 11:30 | Real captions (Kenny). Real answers on the fake log (Paul). HUD with live feed (Jogindar). The tunnel and the iPhone capture page working (Vince) |
| 12:30 | **Full end-to-end test**: walk, "Jarvis, …", answer with photo and voice. Anything not working is cut |
| 1:30 | Tune prompts on photos from the real demo route. HUD polish. Paul switches to pitch, Devpost and backup video. Stretch goal only if everything works |
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
- Is there a better mic than the laptop's built-in one (wired earbuds with a mic)?

## Git rules

- Never commit directly to `main`. Work on a branch: `frontend/<task>`,
  `backend/<task>`, or `ai/<task>`.
- Before starting a task: `git checkout main && git pull && git checkout -b <branch>`.
- Keep branches small and merge within ~45 minutes: open a PR and squash-merge.
- Never force-push to `main`. Never commit `.env`, `data/`, or API keys.
- If you run two agents at once, give each its own `git worktree`.
