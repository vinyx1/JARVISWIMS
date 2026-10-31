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
  "kind": "find" | "retrace" | "other",
  "frames": [ { "id": "f_000101", "url": "/frames/f_000101.jpg", "ts": 1730400000000, "note": "jacket on couch" } ]
}
```
For `retrace`, `frames` is ordered from **now back to the target** (the
breadcrumbs to walk). For `find`, the first frame is the best match.

## POST /preview  ·  GET /preview.jpg

Live preview for the HUD, separate from `/frame`. While capturing, the phone sends a
small JPEG (`image`, ~480px, low quality) about 5 times a second. The backend keeps only
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

Clears the log and stored frames. Use it between demo runs.

## Types

```ts
type Caption = {
  scene: string;         // one sentence
  room_guess: string;    // "kitchen", "hallway", "outside", "unknown"
  objects: string[];     // notable movable items: "black jacket", "keys"
  landmarks: string[];   // fixed things useful for navigation: "red poster", "staircase"
};

type LogEntry = { id: string; ts: number; url: string; caption: Caption | null };
```
