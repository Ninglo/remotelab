# Native activity transcript acceptance

2026-09-08: The acceptance fixture must be an actual RemoteLab session, not a
standalone page that happens to reuse components. A synthetic history was staged
before registering a new explicitly named MOCK session. No provider or tool ran.

The native browser check exposed `renderActivityNote is not defined` when opening
the process block: `static/chat.js` included the new module, but the actual HTML
entry did not. Added the versioned, nonce-bearing script to `templates/chat.html`.
The compact-card test now checks the actual HTML entry and ordering before init.

Evidence: the new assertion failed before the template change and passed after.
Authenticated Chromium against the live chat page loaded the real event block and
lazy details: 9 tool cards, 5 file cards, one row for repeated start/result ID,
working input/output switching and diff disclosure, zero page errors/warnings,
zero stale running rows in the completed history, and no page overflow at 390px.
Full `npm test`, the file-size advisory, and `git diff --check` passed.

This fixture tests persisted history and normal UI loading. It does not claim to
provide timed live replay; the isolated preview's replay is not native acceptance.
