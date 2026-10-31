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
{ "id": "f_000123", "caption": { ...Caption } }
```
Captioning happens synchronously. The frontend should not wait on the response
before taking the next photo: fire and forget, and log errors.

## POST /ask

```json
{ "question": "where did I leave my jacket?" }
```

Response `200`:
```json
{
  "answer": "Your jacket lies upon the couch, mortal... Turn back past the kitchen.",
  "kind": "find" | "retrace" | "other",
  "frames": [ { "id": "f_000101", "url": "/frames/f_000101.jpg", "ts": 1730400000000, "note": "jacket on couch" } ]
}
```
For `retrace`, `frames` is ordered from **now back to the target** (the
breadcrumbs to walk). For `find`, the first frame is the best match.

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

type LogEntry = { id: string; ts: number; url: string; caption: Caption };
```
