# Frontend integration notes

The frontend is implemented on `frontend/chat-camera`. It uses plain browser modules; no build step, frontend API keys or microphone access. Source files remain under `frontend/`. Vincent’s upstream changes through `84f3dd4` are merged; backend files and shared API/team rules are preserved exactly as upstream. Direct user requirements retain the chat-first, typing-only interface instead of the voice/full-screen HUD described in the updated repository plan.

## Preview and existing backend

For a frontend-only preview, run `python3 -m http.server 8765 --bind 127.0.0.1 --directory frontend` from the repository root, then open http://127.0.0.1:8765. Camera selection works on supported secure/localhost origins; API calls show unavailable until a backend serves the same origin.

For the integrated application, start the existing FastAPI backend using the repository's README. It serves this frontend at `/`. Use loopback for the initial laptop demo. The current `ai.py` and `answer.py` are stubs; the UI labels placeholder results rather than presenting real recognition. Answering now belongs to Paul (D); Kenny (C) owns captions.

Implemented existing requests: multipart `POST /frame` (`image`, sampled epoch-ms `ts`); JSON `POST /ask` (`question`); `GET /log`; `GET /latest`; `POST /reset`. Upload acknowledgements accept `caption: null`, matching Vincent's background captioning. `/latest` is polled once per second with one request pending at a time; the same frame ID can transition from analyzing to captioned. Pending captions are normal, not failed uploads. The laptop side preview shows received phone/replay snapshots when no local camera is open, and labels them as snapshots rather than live video. Images are restricted to same-origin frame paths.

`/capture.html` provides the separate phone camera workflow expected by README: rear camera by default, Start/Stop, roughly three-second uploads, best-effort wake lock, and explicit pause when hidden. On the phone use Vince's HTTPS tunnel; the laptop stays on localhost. Continuity Camera remains available directly on the laptop.

Uploads are bounded to one in-flight per page, but do not wait for background AI to finish. There is no frontend backlog. Timeouts pause capture and block reset/resume when upload completion is uncertain. Browser cancellation is not server cancellation.

The reset UI waits for this page's accepted upload and checks `/log` for pending captions before calling `/reset`. The user must stop remote phone capture first. This cannot serialize uploads from other clients: B still needs server-side session/concurrency protection. Specifically, background captions may outlive reset and the current store reuses frame IDs, so an old job can label a new frame; jobs need a generation/session guard or non-reused identity. The frontend pending-caption check reduces this risk but cannot make a cross-client atomic guarantee or recover permanently failed caption jobs. Capture stop releases camera tracks; accepted server work may finish. No automatic retry of uncertain uploads.

## Required calibration API — proposal for Person B

These routes are an explicit proposed integration seam, not existing backend capabilities. Until connected, the wizard shows an unavailable message and never marks the workspace calibrated.

- `GET /calibration/status`: validated profile below, or `{status: "required", marker_url: "/calibration/assets/reference.pdf"}`. Supply the actual marker set; no arbitrary print dimensions assumed.
- `POST /calibration/start`: JSON `{deviceId, width, height, marker_edge_m, reference: "glasses"}`; response `{session_id, status, message?}`. Check/reuse intrinsic calibration or request further views.
- `POST /calibration/{session_id}/frame`: multipart `image` + `ts`; response `{status, message?}`. Only `status: "ready_to_validate"` advances from scan to independent check.
- `POST /calibration/{session_id}/finish`: JSON `{checkpoint_marker_edge_m}` after the checkpoint image; return a validated profile or failure status/message. Checkpoint uses the second marker in the supplied board set at an independent location.
- `POST /calibration/{session_id}/cancel`: release/discard the draft session.

Validated profile:

```json
{
  "status": "ready",
  "valid": true,
  "calibration_id": "calibration-uuid",
  "map_id": "map-uuid",
  "camera_id": "browser-device-id-from-start",
  "width": 1280,
  "height": 720,
  "summary": "Measured validation result and supported operating envelope"
}
```

Dimensions/device must match the actual capture settings. Intrinsic calibration, measured scale, camera pose and triangulation are backend responsibilities. The frontend scan takes up to twelve sequential frames per pass and repeats as requested. Pure rotation is not triangulation; newly observed targets also need supported geometry. The numeric result must use a fresh query pose with the room reference visible unless intervening tracking has been validated. Moved anchors invalidate the map.

## Required structured directions — proposal for B/C

Extend the existing `/ask` shape with `direction`, retaining `answer`, `kind` and `frames` for compatibility. The frontend never displays the frame attachments. Successful geometry fixture (timestamps below are illustrative):

```json
{
  "answer": "Grounded answer text",
  "kind": "find",
  "frames": [],
  "direction": {
    "status": "located",
    "valid": true,
    "reference": "glasses",
    "bearing_deg": 30,
    "horizontal_distance_m": 5,
    "query_pose_ts": 1793450000000,
    "calibration_id": "calibration-uuid",
    "map_id": "map-uuid",
    "historical": true,
    "last_seen_ts": 1793449990000,
    "bearing_error_deg": 5,
    "distance_error_m": 0.5
  }
}
```

Positive bearing is left of glasses facing; horizontal range is straight-line displacement, not walking distance. Backend must already account for tilt/gravity and observation/query transform differences. Backend and browser epoch clocks must be compatible for the current one-second query-pose freshness gate; a remote backend needs clock-offset handling before use.

UI conservatively rejects invalid, stale, incompatible or nonfinite geometry, angular error over 15°, range error over 0.5 m, or historical results missing valid last-seen time. It rounds to 5° and 0.5 m and labels estimates “about/roughly”; these formatting choices are provisional and need physical accuracy validation. A real result after long inference may require reacquiring pose immediately before returning `/ask`.

Failure statuses: `pose_required`, `range_unknown`, `ambiguous`, `not_seen`, `calibration_invalid`; return unknown numeric fields as null. Lost tracking should return `pose_required`. Plain LLM prose containing distances does not unlock directions. Camera-profile validity and current pose are distinct.

## Verification

- `node --test frontend/test/core.test.mjs` — dependency-free state, geometry and API checks, including null captions and late polling results (Node 20+).
- `node frontend/test/browser.cjs` — requires Playwright and installed Google Chrome, plus the frontend preview at port 8765. Set `PLAYWRIGHT_MODULE` to an installed Playwright module path if needed. Uses a synthetic camera and intercepted API fixtures, including delayed captions, remote snapshots and the phone page; does not verify real Continuity Camera or model accuracy.
- Optional `SCREENSHOT_PATH=/absolute/path.png` saves the clean desktop screenshot during the browser test.
- Real-device verification remains required: actual iPhone selection, permission flow, freeze/disconnect behaviour, measured calibration, moving-camera localization and angle/range accuracy.

No paid API calls, external publishing, private camera capture, backend geometry, real object-recognition integration, or real glasses API integration were performed by this frontend task.
