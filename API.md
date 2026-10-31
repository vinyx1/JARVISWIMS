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
