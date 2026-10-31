# Round 2 tasks (after the 12:30 live test)

The live test worked end to end. It found three problems. Each task below stays in its
owner's files from `CLAUDE.md`. The contract changes are already in `API.md`.
Original schedule: merge by 1:45, Paul switches to pitch at 1:30, code freeze at 2:15.

**Status reviewed against `main` at `8c09f06` (31 October 2026).** Checked boxes mean
implemented in the merged code; they do not certify real-device or model accuracy.
Jogindar's frontend PR #19 and Paul's glass HUD are merged. The main remaining code work is
Paul's registered-item answering and ambiguity handling. Real demo validation remains open.

## What the test showed

1. **"Where's the monitor?" picks the wrong one.** The captions never said "monitor".
   They said "silver laptop on table" about 15 times, plus one "wall-mounted TV screen".
   With identical captions, Jarvis can't tell two items apart, so he just picks the most
   recent. This is mostly a caption problem (Kenny), plus how answers handle more than one
   match (Paul).
2. **The HUD looks like still images, not a camera.** The preview does work: the phone sent
   about 4.9 frames a second for the whole run. That's the ceiling with one upload in
   flight at a time through the tunnel. Aim for ~10–15 fps by allowing 2–3 uploads in
   flight at once. True video (WebRTC) is out of scope with two hours left.
3. **New feature: "Jarvis, this is my laptop. Remember it."** Jarvis takes what the camera
   sees right now, describes that exact item (color, brand, stickers), and saves it as
   *yours*. From then on, captions tag it as `MY laptop (...)`, and "where's my laptop?"
   finds yours, not the five others in the room.

## Remember flow (the shared design)

```
"Jarvis, this is my laptop, remember it"
  → POST /ask                      (HUD, unchanged)
  → main.py spots "this is my X" / "remember this X"  (regex, no LLM)
  → image = newest preview (what the camera sees now), else the newest frame;
    it's saved as a normal frame so it has a url
  → ai.describe_item(jpeg, "laptop") → "silver MacBook with a pumpkin sticker on the lid"
  → store.remember("laptop", description, frame)   → data/mine.json
  → reply {answer: "Noted, sir. Your laptop: a silver MacBook with a pumpkin sticker.",
           kind: "remember", frames: [that frame]}
Later frames: ai.caption_frame(jpeg, mine) → objects include "MY laptop (silver MacBook, pumpkin sticker) on table"
Later asks:   answer.answer(question, log, mine) → "my laptop" means the registered one
```

## Kenny (C): `backend/ai.py`, `prompts/caption.md`

- [x] **Distinct caption rules:** monitor/laptop/TV distinction and one identifying detail
  are in `prompts/caption.md`.
- [x] **`describe_item(jpeg, item)`** identifies an item and falls back to the item name
  when the model request fails.
- [x] **`caption_frame(jpeg, mine=())`** accepts registered items and reference images.
  Confident matches use `MY <item> (<description copied exactly>) <where it is>`;
  `_exact_mine` normalizes the registered description.
- [ ] Verify distinct captions and MY tagging against Vince's run-1 photos and two similar
  real objects. Record the results; implementation alone does not prove recognition quality.
- [ ] Confirm Paul has adopted the exact MY wording above in his answer prompt.
- [ ] Confirm sample cleanup from PR #14 is complete, including image dimensions.
  Current tracked sample folders have no spaces and no `.vscode/` files are tracked.

## Paul (D): `backend/answer.py`, `prompts/answer.md`, `tests/**`

- [ ] **`answer(question, log, mine: list[dict] = ())`:** add the optional parameter and
  put registered items in the prompt. Current `answer()` still accepts only question/log;
  Vince's signature-aware caller will pass `mine` once this lands.
- [ ] **"my X" means the registered X:** prefer frames tagged `MY <item>` or matching
  its registered description. If X is unregistered, retain the existing behavior.
- [ ] **Multiple plausible matches:** briefly explain the ambiguity and return the
  candidate frames rather than silently choosing one. A specific identifying detail
  should select the matching item. The frontend candidate picker is already merged.
- [ ] Add tests with two similar items, one registered, plus an ambiguous query that
  returns multiple valid frame references.
- [ ] Confirm pitch, Devpost and backup video are ready. Demonstrate "this is my laptop"
  followed by finding that same laptop among look-alikes.

## Jogindar (A): `frontend/**`

- [x] **Smoother feed implementation:** phone previews every 100ms at 360px / quality
  0.45, up to three uploads in flight, timestamped requests, and serial HUD preview
  polling every 70ms while live. Backend rejects older uploads.
- [ ] Measure actual preview FPS on the real iPhone through the tunnel; target ~10+ FPS.
  Synthetic concurrency checks do not establish real-device throughput.
- [x] **Remember reply:** gold `REGISTERED · MY <ITEM>` heading and photo, without a route strip.
- [x] **MY ITEMS:** loads `GET /mine` on startup, after remember, after reset and on restoration.
- [x] **Multiple find candidates:** side-by-side selectable photos update the evidence image.
- [x] **Selected-object outline:** normalized `frames[].box` draws a gold rectangle on
  the matching evidence photo; invalid/missing boxes preserve the normal answer/photo.
- [x] Retain round-two features with Paul's merged glass HUD.
- [ ] Recheck phone capture, HUD layout, microphone and voice on the final projector setup.

## Vince (B): `backend/main.py`, `backend/store.py`, `scripts/**`

- [x] **Remember routing:** regex detection, current preview with saved-frame fallback,
  item description, registration and a no-image response are implemented.
- [x] **Store:** `remember(item, description, frame)` and `mine()` persist to `data/mine.json`;
  `reset()` clears registrations too. The implementation takes a frame dict, not just its ID.
- [x] **`GET /mine` and wiring:** registrations reach captions; signature-aware calling
  passes them to answers once Paul's optional `mine` parameter exists.
- [x] **Timestamped `/preview`:** older uploads are ignored.
- [x] **Smoke script:** includes remember registration, `/mine` and reset checks.
- [x] **Object boxes:** `/ask` calls `ai.locate_object` for selected evidence frames and
  attaches normalized boxes, with timeout/failure fallback. `JARVIS_BOX=0` disables it.
- [x] **Voice and stage setup:** `/speak` supports ElevenLabs with browser fallback;
  `scripts/demo.sh` starts the demo server and tunnel.
- [ ] Rerun the smoke test and full two-laptop flow on the actual demo machine with keys.
- [ ] Verify outline accuracy and answer latency on real photos; disable boxes if too slow.
- [ ] Verify reset cannot let an old in-flight caption or registration repopulate a new
  session. Until protected server-side, stop phone capture and wait for pending work
  before resetting; the HUD's local guard cannot cover other clients.

## Verification and final rehearsal

- Automated baseline at `8c09f06`: **20 frontend tests and 28 backend tests pass**.
  These checks do not exercise real provider calls, iPhone/tunnel FPS or venue acoustics.
- [ ] On Vince's setup: capture two look-alike laptops, register one, move it, then ask
  "where's my laptop?". Check the correct evidence, MY ITEMS, outline and spoken reply.
- [ ] Ask an ambiguous query and confirm multiple candidates once Paul's changes land.
- [ ] Test wake word, hold-Space and typed fallback in venue noise; check projector readability.
- [ ] Complete rehearsals and record a backup video.

Paul's answer changes are the remaining dependency for registered-item retrieval.
Run `scripts/smoke.py` before and after integration as required by `CLAUDE.md`.
**The smoke script resets memory:** use a disposable backend or intentionally cleared
rehearsal session, never a session whose captured data must be preserved.
