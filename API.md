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

Any frame may also carry an optional `box: [x0, y0, x1, y1]`, the item's position as
fractions (0–1) of the photo's width and height, from `ai.locate_object`. The HUD draws it
as a gold outline. A missing box just means no outline; `JARVIS_BOX=0` turns boxes off.

## GET /interaction

Latest completed phone question and answer for the display-only laptop HUD, or `null`.
The phone calls `/ask` and plays `/speak` on its own device. The HUD polls this endpoint
about once a second and displays the question, answer and evidence without recording or speaking.

```json
{ "id": "unique-exchange-id", "question": "Where is my helmet?",
  "result": { "answer": "On the chair, sir.", "kind": "find", "frames": [] } }
```

State is held in memory for one active demo, replaced on each completed `/ask`, and
cleared on reset or server restart. Reset returns `409` while a question is in flight, so an old registration cannot complete across that reset.
This is a latest-exchange relay, not a queue for multiple simultaneous users.

## POST /speak

```json
{ "text": "Very good, sir." }
```
Returns `200 audio/mpeg` in Jarvis's ElevenLabs voice, or `204` when it can't (no
`ELEVENLABS_API_KEY`, slow, or failed). On `204` the HUD speaks with the browser's British voice.

## GET /mine

The registered items, oldest first. Cleared by `POST /reset`.
```json
[ { "item": "laptop", "description": "silver MacBook with a pumpkin sticker", "frame_id": "f_000140", "url": "/frames/f_000140.jpg", "ts": 1730400000000 } ]
```
After registration, captions write the item as `"MY laptop (silver MacBook, pumpkin sticker) on table"`.

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
