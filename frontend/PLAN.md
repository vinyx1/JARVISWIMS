# Visual Memory Frontend Implementation Plan

> **For agentic workers:** When implementation is requested, use `superpowers:executing-plans` for inline execution, or `superpowers:subagent-driven-development` only when delegation is authorized. Track the steps below; this document does not authorize implementation by itself.

**Goal:** Build a laptop-hosted, typing-only chat interface with a small side camera preview, explicit Start/Stop controls, a guided calibration setup and grounded angle-and-distance answers relative to the glasses' facing direction. Branding remains undecided.

**Architecture:** Keep the existing same-origin static frontend and FastAPI foundation. Separate camera lifecycle, network requests, calibration UI and chat rendering into small browser modules, with `app.js` coordinating explicit state. Spatial calibration and direction results require agreed backend extensions; the current endpoints alone cannot provide them.

**Tech stack:** Existing HTML, CSS and vanilla JavaScript; browser media APIs and Fetch. No voice input/output, React, Vite, npm build, frontend cloud service or API key in the browser.

**Spec:** User clarifications in this chat supersede earlier screen/voice defaults: laptop-first chat, side picture-in-picture-style preview, typing only, Start/Stop, direction answers instead of evidence photos, and glasses-aligned orientation. Existing repository ownership remains; shared specification/API updates require coordination. The repository currently says Echo, but naming is deferred.

## Global constraints

- Person A owns `frontend/**`. Coordinate backend requirements with Person B and response semantics with Person C. Shared `API.md`/`CLAUDE.md` changes need team agreement.
- The current frontend samples every 3 seconds and sends a roughly 640-pixel-wide JPEG plus epoch-millisecond `ts` to `POST /frame`.
- `POST /ask` accepts `{question}` and returns `{answer, kind, frames}`; each evidence item has `{id, url, ts, note}`. `GET /log` retrieves sightings; `POST /reset` clears memory.
- Typing only. Voice input/output is out of scope, including the skeleton's automatic speech output.
- The camera is the iPhone through Continuity Camera on the laptop. Do not assume phone-native depth/IMU, browser availability on every device, or a glasses integration.
- Angle and distance are required product outputs, enabled only when the backend supplies validated geometry and a current query pose. Show localization-unavailable states rather than invented numbers. Do not show photo attachments, a photo-memory strip or a room map in the primary chat.
- Assume the camera behaves as glasses aligned with the wearer's view. Left/right means relative to current glasses facing, not torso heading. Continuity Camera emulates that camera; laptop position never supplies wearer pose.
- Never send images on page load. Show capture state and explain that the current proposed backend uses an external AI provider. UI “live camera” does not mean the AI responses are real; the current AI module contains stubs.

## Review focus

1. Permission resolves after Stop: release the returned stream instead of restarting capture (Task 2).
2. A response arrives after Stop, device switch or reset: it must not overwrite newer UI state (Tasks 2–4).
3. Captioning exceeds the sampling interval: requests must remain bounded and the user must see pending/error status (Task 3).
4. A chat response contains markup or unsupported coordinates: render inert text and display spatial values only from a validated structured geometry result (Task 4).
5. A device silently freezes or vanishes: do not display an unchanged frame as a newly observed scene (Task 2 and real-device acceptance).

## Proposed screen

Desktop: chat occupies the main area, with messages and a persistent typed composer. Place a small picture-in-picture-style preview beside the chat, with device selection, Start/Stop and a calibration-status chip. This is an in-page panel, not a requirement to use the browser Picture-in-Picture API. Calibration opens a short guided panel and returns the user to chat.

Target the laptop viewport first. On narrower windows, dock or collapse the small preview without covering chat or its composer. Keep Stop accessible. Do not turn this into a phone-first application.

Use the existing dark palette and neutral working labels while branding is deferred. Keep visible focus states, readable contrast, labelled controls, an `aria-live` status region and reduced-motion support. Decorative animations must not obscure chat or controls.

Primary labels: **Enable camera**, **Calibrate**, **Start**, **Stop**, **Send**, **Clear memory**. Distinguish **Preview only**, **Capturing**, **Saving sighting**, **Capture stopped**, **Camera disconnected**, **Calibration required**, **Tracking lost**, and **Service unavailable**. Stopping future capture does not delete saved memories; Clear memory is separate.

## File boundaries

| File | Responsibility |
| --- | --- |
| `frontend/index.html` | Semantic layout, labelled controls and module entry point |
| `frontend/style.css` | Responsive panels, controls, readable states and reduced motion |
| `frontend/app.js` | Wire UI events, state generations, capture scheduling and queries |
| `frontend/camera.js` | Permission, enumeration, stream selection and cleanup |
| `frontend/api.js` | Endpoint calls, timeout/error parsing and response checks |
| `frontend/render.js` | Safe chat/direction rendering and last-seen formatting |
| `frontend/calibration.js` | Guided calibration steps, progress, validation results and retry |
| `frontend/tests.html`, `frontend/tests.js` | Small browser-based checks with fake media/fetch; clearly separate from the live app |

Use `<script type="module" src="app.js">`. Keep test pages dependency-free and manually runnable at `/tests.html`. They must never request real camera permission or call the real reset endpoint.

## Task 1 — establish the interface and screen shell

**Files:** modify `frontend/index.html`, `frontend/style.css`, `frontend/app.js`; create `frontend/api.js`.

**Interfaces:** `uploadFrame(blob, ts, {signal}) -> Promise<{id, caption}>`; `askQuestion(question, {signal}) -> Promise<{answer, kind, frames}>`; `getLog({signal}) -> Promise<LogEntry[]>`; `resetMemory({signal}) -> Promise<{ok}>`. Export from `api.js`, preserving `API.md` field names. Check `response.ok`, expected JSON shape and distinguish network, HTTP and invalid-response failures.

- [ ] Implement a main chat thread and typed composer, small side preview, labelled camera selector, Enable/Start/Stop, calibration entry, status region and clear-memory control. All controls have meaningful initial disabled states.
- [ ] Add laptop-first layout CSS with a dominant chat column and compact side preview. Use neutral labels; avoid adding dependencies.
- [ ] Add the API wrapper and wire the existing endpoints without changing their contracts. Display a readable error; never render an error body as a successful answer.
- [ ] Agree with B on one-in-flight uploads, timeouts, and reset concurrency. `API.md` currently recommends fire-and-forget: the proposed bounded scheduler needs an agreed documentation change by the shared owner before integration.
- [ ] Check at 390px and 1440px widths and with keyboard-only input: no horizontal overflow, all controls reachable, capture/error text readable.

**Exit:** screen works against labelled fixtures; endpoint shapes are documented in code. Fixture checks are not evidence that the AI works.

## Task 2 — reliable Continuity Camera lifecycle

**Files:** create `frontend/camera.js`; modify `frontend/app.js`; create `frontend/tests.html`, `frontend/tests.js`.

**Interfaces:** `requestCameraAccess() -> Promise<void>` requests video permission and releases its temporary tracks; `listCameras() -> Promise<MediaDeviceInfo[]>` returns video inputs; `openCamera(deviceId) -> Promise<MediaStream>` selects the requested device; `closeCamera(stream) -> void` stops every track. App owns the active stream and a monotonically increasing operation generation.

- [ ] Add fake-media checks before wiring lifecycle: two Start attempts create one active session; Stop during a pending permission/open operation releases any late stream; device switch stops all previous tracks.
- [ ] On Enable camera, request permission, enumerate devices with usable labels and populate the selector. Persist a device preference as a hint, revalidate it each session, and never silently switch to another camera when the selected iPhone disappears.
- [ ] Start the selected preview, wait for usable video dimensions, and enter preview-ready state. Start remembering separately enables sampling. Display the device label and active mode.
- [ ] Stop clears the timer, stops tracks, releases an acquired wake lock and invalidates old callbacks. Permission denial and missing hardware produce specific instructions and a Retry action.
- [ ] Listen for track termination and supported device-change notifications; provide manual Refresh cameras because event support varies. Detect preview stalls using available frame-progress signals plus a conservative timeout. Label stalled/unknown progress instead of refreshing observation timestamps.
- [ ] Pause sampling while the page is hidden; make the paused state clear on return. Handle wake-lock absence without blocking the desktop workflow. Release resources on page exit.
- [ ] Run `/tests.html`; verify all lifecycle assertions pass. Then test actual iPhone selection, physical disconnect and reconnect on the Mac. This cannot be proved with fake streams.

**Exit:** Enable/Start/Stop/retry/device switch never duplicate sessions or leave the camera active unexpectedly.

## Task 3 — bounded frame sampling and honest status

**Files:** modify `frontend/app.js`, `frontend/api.js`, `frontend/tests.js`.

**Interfaces:** `captureFrame(video) -> Promise<{blob, ts}>` returns JPEG and the time the browser sampled it, not an invented sensor exposure timestamp. `createCaptureLoop({capture, upload, onStatus}) -> {start(), stop()}` schedules work and invalidates stale UI updates.

- [ ] Add deferred-promise checks: an upload taking longer than 3 seconds never permits another upload to overlap in that capture session; a late old-session result cannot update the current caption/status.
- [ ] Sample only when video has a fresh usable frame and capture is enabled. Resize proportionally to approximately 640px width, encode JPEG, and set `ts` at sampling time. Handle a null/failed canvas encoding explicitly.
- [ ] After agreement with B, use a three-second sampling opportunity with one pending upload; skip opportunities while busy. Record confirmed saves only after a valid `/frame` success.
- [ ] Use a visible request timeout and stop scheduling on uncertain timeout rather than repeatedly starting more server work. Aborting browser Fetch does not guarantee backend inference has stopped. Resume/retry is explicit until B provides stronger server capacity/session guarantees.
- [ ] Show latest successfully saved scene and timestamp separately from live-preview state. A working preview with failed captioning must say that sightings are not being saved.
- [ ] Stop invalidates local callbacks; coordinate whether the last accepted backend upload may still finish. Never claim Stop cancels or deletes server work. Do not automatically retry non-idempotent uploads after uncertain failures.
- [ ] Run the delayed/failure checks in `/tests.html`, then observe the network panel during a real slow request: no unbounded upload queue and no stale success status.

**Exit:** slow/unavailable AI cannot silently flood the backend or manufacture fresh observations.

## Task 4 — chat, grounded directions and memory controls

**Files:** create `frontend/render.js`; modify `frontend/app.js`, `frontend/index.html`, `frontend/tests.js`.

**Interfaces:** `renderAnswer(container, result) -> void`; `formatSeenAt(ts, nowMs) -> string`; `renderDirection(container, direction) -> void`. Agree a structured direction extension with B before integration: status, signed bearing in degrees (positive left), horizontal distance in metres, reference `glasses`, last-seen time, historical flag, calibration/map IDs, query-pose timestamp, validity and measured error metadata. Unknown numbers are null. This is a proposed contract, not an existing endpoint feature.

- [ ] Add checks for absent/ambiguous targets, invalid/future timestamps, malicious response text, invalid/nonfinite coordinates, incompatible calibration, stale pose, reversed query response order and reset during a pending query. Unknown timestamps must say unavailable, not “just now.”
- [ ] Trim and reject blank questions; submit on Enter, show pending state and allow retry after error. Use a request generation so an older answer cannot replace a newer one.
- [ ] Render user and assistant messages using `textContent`. Keep the conversation visible and scroll only when the user is already near its end. Validate all response fields.
- [ ] Make the assistant answer angle/distance first when geometry is valid, such as “About 30° left, roughly 5 metres away.” Apply backend-supported rounding; never derive range from text, box size or an arbitrary progress indicator. Include “last seen” when historical.
- [ ] If the target or current pose is unavailable, ask for a rescan, marker view or clarification. No image attachments or invented numeric fallback. Numeric prose from the old model-only endpoint is not a validated spatial result.
- [ ] Preserve memory on the backend without displaying a photo-memory strip. Keep any diagnostic evidence IDs internal; no frontend photo gallery is required.
- [ ] Clear memory requires a simple explicit destructive confirmation. Stop capture, invalidate UI generations and call `/reset`; clear the UI only after success. Do not resume sampling automatically.
- [ ] Gate Clear memory on B's reset/upload coordination for a reliable guarantee. Browser abort alone cannot prevent an old request from repopulating server memory. If that backend guarantee is missing, mark integration incomplete rather than hiding the race.
- [ ] Run rendering/order checks in `/tests.html`, then demonstrate calibrated object capture → typed question → validated direction → reset with B/C. Record whether real geometry/model calls or fixtures supplied the answer.

**Exit:** chat gives grounded directions or a clear localization/identity failure, with historical recency where needed and no photo-based primary response.

## Task 5 — accessibility and final polish

**Files:** modify `frontend/app.js`, `frontend/index.html`, `frontend/style.css`.

- [ ] Remove the existing automatic speech synthesis. Do not add a microphone, read-aloud toggle, speech dependency or microphone permission request.
- [ ] Check keyboard focus, input labels, `aria-live` announcement volume, reduced motion and narrow-screen behaviour. Keep status conveyed by text, not colour alone.
- [ ] Add neutral loading states while naming is deferred. No fake metrics, decorative “tracking lock,” unsupported compass, or looping animation implying real localization.
- [ ] Rehearse on the actual presentation laptop and iPhone. Record browser, permission/setup steps and failures for the team's setup documentation owner.

**Exit:** polish improves the live demonstration without making capture or evidence harder to understand.

## Task 6 — quick guided calibration setup

Implement the wizard after camera selection, before enabling numeric answers in Task 4. The flow is intended to be short for returning users; do not promise a fixed duration before real-device testing. Person A builds the wizard, Person B owns pose/calibration/triangulation, and Person C supplies consistent object correspondences. Calibration cannot be implemented solely in the frontend or by caption prompts.

**Files:** create `frontend/calibration.js`; modify `frontend/index.html`, `frontend/app.js`, `frontend/api.js`, `frontend/style.css`, `frontend/tests.js`.

**Interfaces:** `createCalibrationWizard({api, onStatus, onComplete}) -> {open(), cancel(), invalidate(reason)}`. Proposed service operations are start calibration, submit calibration frame, finish/validate, get status, and cancel. B must agree endpoint names and schemas in the shared API contract. Each response includes session ID, step, status, reason and camera/map/calibration versions. The client must never set validity merely because the user clicked Next.

### User flow

1. **Select camera.** Confirm the actual iPhone preview. Explain: “Directions follow where your glasses are pointing.” For the prototype, keep the phone aligned with that intended view. Lock the lens, resolution and crop for calibration; preview mirroring is display-only.
2. **Set a measured reference.** Provide a downloadable, backend-generated marker board with a known layout. Place it on a stationary background surface, measure the actual printed marker dimension and enter it in centimetres. Never assume print scaling is correct or infer a chair's dimensions from its class. Show a simple example of which edges to measure.
3. **Check the camera profile.** Reuse a previously validated intrinsic/lens profile only if it matches the exact device and image settings. Otherwise guide several views of the measured board at different angles and image locations until the backend accepts intrinsic calibration. Label this one-time step separately from the shorter room scan; a single front-on image is not sufficient validation.
4. **Scan the background.** Ask: “Keep the reference in view and move sideways slowly, then hold still.” Collect a short explicit calibration burst with timestamps and a bounded queue. Show actionable backend feedback: reference found, more sideways movement needed, image blurry, or insufficient overlap. Pure turning in place does not provide a triangulation baseline. A proposed 30–50 cm sideways movement is a starting cue, not a claimed accurate baseline or universal requirement.
5. **Validate.** Ask the user to show a second independently measured reference/checkpoint in the intended working area and enter the relevant measured length. B defines the supported fixture and comparison. Backend checks reprojection, metric scale, positive depth, parallax and independent error. Display pass/retry and the supported operating envelope; no success from a timer or decorative progress bar.
6. **Return to chat.** Show “Calibrated” and Start. Mark the glasses-aligned reference and last validation time. If camera pose is lost later, show “Look at the reference to restore directions”; full camera calibration is unnecessary unless its configuration changed.

### Geometry and operating rules

- Background features help localization but arbitrary unmeasured objects do not establish metric scale. Known reference dimensions plus calibrated camera pose ground the measurement.
- Triangulation needs a static target observed consistently from multiple translated, calibrated viewpoints. A room scan does not automatically locate an object newly seen in only one image. Such a target needs a further multi-view observation or another validated range method; ask for a short scan rather than inventing distance.
- For the initial reliable implementation, require the measured reference board visible during observation and query. Losing it disables numeric directions unless B has separately verified intervening pose tracking. Background localization without the board is a later validated capability.
- Use calibration capture frames for geometry, not the slow external caption queue. Normal memory snapshots retain the agreed sampling interval. Calibration bursts have an explicit temporary capture indicator and bounded backend capacity.
- Distinguish camera intrinsics, room map and current pose. Moving the head normally changes pose; it does not invalidate lens calibration. Moving an anchor invalidates its room geometry. Switching lens/crop/resolution invalidates the camera profile and dependent geometry.
- Store only profile IDs/preferences in browser storage; B persists validated geometry and provenance. Cancel, Stop, disconnect or a stale session response must not produce a new valid profile.

**Verification:** in `/tests.html`, simulate missing reference, insufficient sideways motion, first-device intrinsic setup, failed validation, cancel/late result, camera-setting change and tracking loss/reacquisition. Then run an actual measured-device check with B: a successful wizard must lead to physically checked bearings/ranges, and a failed/lost pose must suppress numbers. Fixture passes alone do not verify spatial accuracy.

**Exit:** a user can complete or retry the setup without technical configuration files; only backend-validated profiles unlock numeric answers. The current repository lacks that backend, so a working visual wizard alone is not completion of calibration.

## Integration dependencies and order

Implement the screen and camera selection first, then calibration UI and the chat interaction in parallel with B/C's backend work. A can use clearly labelled fixtures while B stabilizes storage and geometry and C replaces AI stubs. Integrate the real paths early; do not wait for the whole UI to be polished.

Person B supplies reliable save/query/reset semantics, bounded backend concurrency, retention, intrinsic calibration, metric mapping, triangulation and current camera pose. Person C supplies object identity/correspondences and grounded query resolution. This expands B's earlier workload: the team must account for spatial work before committing to its original six-hour schedule. The frontend cannot independently verify object identity or recover metric geometry from answer text.

Use small `frontend/<task>` branches according to `CLAUDE.md`; do not overwrite the existing uncommitted team plan, modify backend files or edit another person's checkout. Coordinate shared documentation changes through the team. No implementation, commit or push is part of this planning task.

## Final acceptance checklist

- [ ] User selects the actual iPhone camera on the Mac and confirms its preview before capture.
- [ ] Start/Stop/Start produces one stream and sampling loop; Stop releases the camera.
- [ ] Permission denied, unplugged camera, hidden page, stalled preview and unavailable backend have distinct visible states.
- [ ] Slow requests stay bounded; stale responses cannot revive stopped capture or replace newer results.
- [ ] Chat is the main interface; the preview is a small side panel and photo attachments are absent.
- [ ] Guided setup validates the measured reference, matching intrinsic profile, translated scan and independent checkpoint before enabling numeric answers.
- [ ] A typed find query displays physically checked angle/distance relative to glasses facing, with historical recency when needed.
- [ ] Missing/ambiguous objects and no evidence produce usable feedback; no invented coordinates appear.
- [ ] Reset removes server memory with B's concurrency guarantee and clears the UI only on success.
- [ ] Returned text is inert; numeric values require valid structured geometry and current pose.
- [ ] Keyboard/laptop-window use works; no voice controls or speech/microphone requests remain.
- [ ] Stub/replay tests and live-device/model verification are reported separately.

Planning complete does not mean these checks have passed. Report implementation outcomes as they are measured.

## Browser API references

- [MDN: selecting a camera with getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [MDN: enumerateDevices and permission-dependent device information](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices)
- [MDN: devicechange support and behaviour](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/devicechange_event)
- [MDN: AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
- [OpenCV: measured marker boards for camera pose](https://github.com/opencv/opencv/blob/5.x/doc/tutorials/objdetect/aruco_board_detection/aruco_board_detection.markdown)
- [OpenCV: triangulation and camera projection matrices](https://docs.opencv.org/4.6.0/d9/d0c/group__calib3d.html)
