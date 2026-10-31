# Phone voice implementation plan

Phone handles voice; laptop is display-only (user approved).

- Add a test for a completed /ask exchange being available at GET /interaction and cleared on reset, with unchanged /ask shape. Keep state in memory, no new dependencies.
- Add phone talk/stop/replay controls, visible recognized text and answers, and typed fallback. Use a single-question recognition session and explicit permission/error states. Cancel pending UI work when leaving.
- Reuse device audio playback and unlock it on a user tap. Surface blocked playback and allow replay; no promise of automatic speech on all mobile browsers.
- Make HUD poll the latest completed exchange and render text/photos/boxes without starting its microphone or speaker. Preserve reset, preview, subtitles and evidence controls.
- Verify unit tests, cross-page mocked browser flow, phone layouts and keyless isolated smoke test. Real iPhone microphone/audio and tunnel remain a device check.
