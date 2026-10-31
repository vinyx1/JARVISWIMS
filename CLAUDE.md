# Echo — the ghost of your last 10 minutes

Halloween hackathon project (6 hours, 3 people, each using a coding agent).
A phone worn on your head snaps a photo every ~3s. Echo, a ghost that has been
"haunting" you, remembers what you saw and answers "where's my jacket?" or
"retrace my steps" with a spooky voice plus photo breadcrumbs.

Read `API.md` for the frontend/backend contract and `README.md` for setup.

## Ownership — agents MUST respect this

| Owner | Files they may edit |
|---|---|
| Person A — frontend | `frontend/**` |
| Person B — backend | `backend/main.py`, `backend/store.py`, `backend/requirements.txt` |
| Person C — AI | `backend/ai.py`, `prompts/**` |

- Only edit files you own. If you need a change elsewhere, stop and tell your
  human so they can ask the owner.
- `API.md` and `CLAUDE.md` are shared. Do not change them without the team agreeing.
  If the contract changes, update `API.md` in the same commit.

## Git rules

- Never commit directly to `main`. Work on a branch: `frontend/<task>`,
  `backend/<task>`, or `ai/<task>`.
- Before starting a task: `git checkout main && git pull && git checkout -b <branch>`.
- Keep branches small and merge within ~45 minutes: open a PR and squash-merge.
- Never force-push to `main`. Never commit `.env`, `data/`, or API keys.
- If you run two agents at once, give each its own `git worktree`.

## Tech choices (keep it boring)

- Backend: Python 3.11+, FastAPI, Anthropic SDK. It also serves `frontend/`
  as static files, so there is one origin and one HTTPS tunnel.
- Frontend: a single plain HTML/JS/CSS page. No build step and no framework.
  Use `getUserMedia`, the Web Speech API, `speechSynthesis`, and the Wake Lock API.
- Storage: JPEGs in `data/frames/` and one append-only `data/log.jsonl`. No database.
- Models: `claude-haiku-5-5` for per-frame captions, `claude-sonnet-5-5` for answering.

## Scope priority (cut from the bottom)

1. Capture, caption, and answer "where's my X?" with a photo
2. A retrace narrative from the landmark sequence
3. Voice in and out (typed fallback)
4. Ghost theme and effects
5. Frame dedup and GPS/compass
