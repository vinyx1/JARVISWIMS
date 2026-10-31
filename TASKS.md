# Round 2 tasks (after the 12:30 live test)

The live test worked end to end. It found three problems. Each task below stays in its
owner's files from `CLAUDE.md`. The contract changes are already in `API.md`.
**Target: everything merged by 1:45**, so there's time to rehearse before the 2:15 freeze.
Paul switches to the pitch at 1:30 as planned.

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
  → store.remember("laptop", description, frame_id)   → data/mine.json
  → reply {answer: "Noted, sir. Your laptop: a silver MacBook with a pumpkin sticker.",
           kind: "remember", frames: [that frame]}
Later frames: ai.caption_frame(jpeg, mine) → objects include "MY laptop (silver MacBook, pumpkin sticker) on table"
Later asks:   answer.answer(question, log, mine) → "my laptop" means the registered one
```

## Kenny (C): `backend/ai.py`, `prompts/caption.md`

- [ ] **Distinct captions.** Name things correctly: monitor, laptop and TV are different
  nouns, so add `monitor` to the plain-noun list. Add one detail that tells similar items
  apart: brand, stickers, size, what's on the screen, or what's next to it. For example,
  "black Dell monitor on left desk showing code", not "laptop on table". Test this on the
  run-1 frames (Vince has a copy) before changing anything else.
- [ ] **`describe_item(jpeg: bytes, item: str) -> str`** (new). One short phrase that
  identifies *this* item for later recognition. On any error, return `item` itself.
- [ ] **`caption_frame(jpeg: bytes, mine: list[dict] = ()) -> dict`.** The new parameter
  is optional, so nothing breaks before Vince wires it in. If the frame shows one of
  `mine` (`{item, description}`), write it as `"MY <item> (<description>) <where>"`.
  Only do this when you're confident it's the same item; otherwise caption it normally.
- [ ] Tell Paul the exact `MY ...` wording once it's settled.
- [ ] Shrink and rename your `samples/` PR (#14) when you have time: ~1280px wide, folder
  names without spaces, and drop `.vscode/`.

## Paul (D): `backend/answer.py`, `prompts/answer.md`, `tests/**` (before 1:30)

- [ ] **`answer(question, log, mine: list[dict] = ())`.** Optional new parameter. Put the
  registered items in the prompt.
- [ ] **"my X" means the registered X.** Prefer frames whose objects say `MY <item>` or
  match its description. If X isn't registered, behave as today.
- [ ] **More than one match:** don't silently pick one. Say so briefly and return both
  frames: "I've seen two monitors, sir: the black one on the left desk a minute ago, and a
  wall TV by the door. The first is likelier yours." If one clearly matches the question's
  details ("the Dell monitor"), pick it.
- [ ] Add a test with two similar items, one of them `MY ...`.
- [ ] 1:30 → pitch, Devpost, backup video. Feature to show off: "this is my laptop".

## Jogindar (A): `frontend/**`

- [ ] **Smoother feed** (`capture.js`, `app.js`): allow 2–3 preview uploads in flight,
  send every ~80–100ms at 360px and quality ~0.45, and have the HUD poll
  `/preview.jpg` every ~70ms while live. Only show a frame if it's newer than the one on
  screen. Send `ts` with each preview, and the backend will drop stale ones. Check it on
  the real iPhone through the tunnel; the target is ~10+ fps.
- [ ] **`kind: "remember"`:** show the photo with a gold `REGISTERED · MY LAPTOP` title
  instead of LAST SEEN, and no route strip.
- [ ] **MY ITEMS** list in the Jarvis panel, from `GET /mine` (load on start, after each
  remember, and after R).
- [ ] When an answer has 2+ frames for `find`, show them side by side as options.

## Vince (B): `backend/main.py`, `backend/store.py`, `scripts/**`

- [ ] **Remember routing in `/ask`:** a regex for "this is my X", "that's my X",
  "remember this/my X" and "X is mine", then the flow above. Use the preview frame if it's
  live, otherwise the newest frame. If there's no image, reply: "I can't see anything yet,
  sir."
- [ ] **`store`:** `remember(item, description, frame_id)` and `mine()`, persisted to
  `data/mine.json`. `reset()` clears it too.
- [ ] **`GET /mine`.** Pass `store.mine()` into `caption_frame` and `answer` (keyword
  arguments, so the code works before Kenny and Paul land their changes).
- [ ] **`/preview`:** accept an optional `ts`, and ignore any frame older than the one held.
- [ ] Smoke test: add one remember question, then rerun the live test with two laptops.

## Merge order

Vince's backend changes merge first: the defaults mean nothing breaks. Kenny, Paul and
Jogindar can merge in any order after that. Run `scripts/smoke.py` before each merge.
