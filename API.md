# API contract

All endpoints are served by the backend on the same origin as the frontend.

## POST /frame

Upload one camera frame. Send it as `multipart/form-data`:

| field | type | notes |
|---|---|---|
| `image` | file (image/jpeg) | ~640px wide |
| `ts` | number | client time, ms since epoch |
| `lat`, `lon`, `heading` | number, optional | ignored unless we get to priority 5 |

Response `200`:
```json
{ "id": "f_000123", "caption": null }
```
The frame is saved instantly, and captioning happens **in the background**:
`caption` is `null` until it's ready (about 1–3s later), and then `/latest` and
`/log` include it. The phone should fire and forget, and log errors.
`/ask` only considers frames that have finished captioning.

## POST /ask

```json
{ "question": "where did I leave my jacket?" }
```

Response `200`:
```json
{
  "answer": "Your helmet is on the chair by the exit sign, sir. Turn back past the snack table.",
  "kind": "find" | "retrace" | "remember" | "other",
  "frames": [ { "id": "f_000101", "url": "/frames/f_000101.jpg", "ts": 1730400000000, "note": "jacket on couch" } ]
}
```
For `retrace`, `frames` is ordered from **now back to the target** (the
breadcrumbs to walk). For `find`, the first frame is the best match. If several
different items match (two monitors), `frames` holds each candidate, best first.

**Remember** ("this is my laptop", "remember this laptop", "that bag is mine"): the
backend spots this itself, takes what the camera sees right now, and registers it.
The reply is `kind: "remember"`, and `frames` holds the one photo with `note` set to the
description. The HUD shows it as `REGISTERED · MY <ITEM>`.
```json
{ "answer": "Noted, sir. Your laptop: a silver MacBook with a pumpkin sticker.",
  "kind": "remember",
  "frames": [ { "id": "f_000140", "url": "/frames/f_000140.jpg", "ts": 1730400000000, "note": "silver MacBook with a pumpkin sticker" } ] }
```

`/ask` gives up after 12s with an in-character "taking longer than expected" reply. If the
answer model fails, a keyword search over the captions answers instead.

**Leaving an item somewhere** ("Jarvis, I'm leaving my AirPods here", "I put my keys here",
"my AirPods are right here", "remember where I put my bottle"): the backend saves what the
camera sees now, describes the spot, and records it as that item's last-seen location
(registering the item first if it's new). Reply is `kind: "remember"` with that photo:
`"Very good, sir. Your airpods: on desk by the window, near the red exit sign."`

## GET /interaction

The latest completed question and answer, from any device (phone or laptop, voice or typed),
or `null`. The HUD and the phone both poll it about once a second: the HUD shows it in the chat,
and every device whose audio switch is on speaks it (phone audio on by default, laptop off).
The device that asked speaks its own answer straight away and skips it here.

```json
{ "id": "unique-exchange-id", "question": "Where is my helmet?",
  "result": { "answer": "On the chair, sir.", "kind": "find", "frames": [] } }
```

State is held in memory for one active demo, replaced on each completed `/ask`, and
cleared on reset or server restart. Reset returns `409` while a question is in flight, so an old registration cannot complete across that reset.
This is a latest-exchange relay, not a queue for multiple simultaneous users.

## POST /listen

Voice input. The browser records one utterance (`frontend/mic.js`) and sends it as
`multipart/form-data`: `audio` (16 kHz mono 16-bit WAV) and `mode`:

- `ask`: everything said is the question (push-to-talk, or right after "Jarvis" on its own).
- `wake`: hands-free; act only if "Jarvis" was said ("Hey Jarvis, where's my helmet?",
  "Where are my keys, Jarvis?"). Anything else is ignored.

Optional `still`: a sharp full-resolution JPEG of what the camera sees as sir speaks. The phone
sends it whenever its camera is on; "this is my X, remember it" uses it to study the item.

The backend transcribes it locally with Whisper (`backend/stt.py`, no API key) and, if there
is a question, answers it exactly like `/ask` (so it also shows on the HUD via `/interaction`).
```json
{ "heard": "Hey Jarvis, where's my helmet?", "question": "where's my helmet",
  "armed": false, "result": { "answer": "…", "kind": "find", "frames": [] } }
```
`armed: true` means "Jarvis" was said with nothing after it: send the next utterance with
`mode=ask`. `result` is `null` when there was nothing to answer. `400` for a bad WAV, `503`
if speech recognition is unavailable.

## POST /still

`multipart/form-data` with `image`: a sharp photo of what the camera sees now. The phone sends
it just before a typed question, so a typed "this is my X" gets the same clear look. `{"ok": true}`.

## POST /speak

```json
{ "text": "Very good, sir." }
```
Returns `200 audio/mpeg` in Jarvis's ElevenLabs voice if `ELEVENLABS_API_KEY` is set, else
`200 audio/wav` from the Mac's `say` (the best installed Daniel voice), or `204` if both fail;
then the page speaks with the browser's British voice.

## GET /mine

The registered items, oldest first. Cleared by `POST /reset`.
```json
[ { "item": "laptop", "description": "silver MacBook with a pumpkin sticker", "frame_id": "f_000140", "url": "/frames/f_000140.jpg", "ts": 1730400000000,
    "last_seen": { "frame_id": "f_000188", "url": "/frames/f_000188.jpg", "ts": 1730400300000,
                   "where": "on desk by the window", "room": "workspace tables", "landmarks": ["window"] } } ]
```
Registration studies the item once with a stronger model: a description, up to five
distinguishing `marks` (scratches, stickers, wear), and a close-up crop kept as its reference
photo. Every later snapshot is checked against that close-up and those marks.
After registration, captions write the item as `"MY laptop (silver MacBook, pumpkin sticker) on table"`.
Every such caption, and every "I'm leaving my X here", updates `last_seen` (optional; only newer
frames replace it). It never expires, so "where's my laptop?" works however long ago that was.

## POST /preview  ·  GET /preview.jpg

Live preview for the HUD, separate from `/frame`. While capturing, the phone sends a
small JPEG (`image`, ~360px, low quality, plus an optional `ts` in ms) about 10 times a second,
with up to 3 uploads in flight. The backend ignores a frame whose `ts` is older than the one it holds. The backend keeps only
the newest one **in memory**: it is never captioned, saved, or seen by Jarvis.
`GET /preview.jpg` returns it, or `204` if nothing arrived in the last 3s (the HUD then
falls back to `/latest`). `POST /reset` clears it.

## GET /latest

Returns the newest `LogEntry`, or `null` if nothing has been captured yet. The
laptop HUD polls this about once a second to show the live feed. Its `caption`
may still be `null`: show the photo immediately with "ANALYZING…", then the
labels once the caption arrives.

## GET /log

Returns the full caption log as a JSON array of `LogEntry`. For debugging and the timeline view.

## POST /reset

Clears the log, stored frames, the preview and registered items (`/mine`). Use it between demo runs.
Captions still running from before the reset are dropped, so it's safe while the phone is capturing.

## GET /health

```json
{ "ai_ok": false, "ai_error": "AuthenticationError: ... invalid x-api-key", "frames": 12 }
```
`ai_ok` turns false when a Claude call fails (bad key, no network) and true again on the next
success. A failing AI never crashes anything; captions just become "unclear frame", so check this.

## Types

```ts
type Caption = {
  scene: string;         // one sentence
  room_guess: string;    // "kitchen", "hallway", "outside", "unknown"
  objects: string[];     // notable movable items: "black jacket", "keys"
  landmarks: string[];   // fixed things useful for navigation: "red poster", "staircase"
};

type LogEntry = { id: string; ts: number; url: string; caption: Caption | null };
type MyItem = { item: string; description: string; frame_id: string; url: string; ts: number };
```
