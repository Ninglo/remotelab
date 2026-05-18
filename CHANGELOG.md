# Changelog

## Unreleased

- Keeps the shipped owner flow centered on sessions and settings after retiring the unused planning surface.
- Removes the last hidden web voice-cleanup path so the composer now sends text directly.
- Keeps session workflow organization derived from `workflowState`, `workflowPriority`, review state, and live activity instead of a parallel planning surface.

## v0.3.2

- Adds session events delta transport: the frontend now fetches only new events since the last known offset, reducing bandwidth and improving response time for active runs.
- Adds interaction mode support (`agent` | `plan`): sessions can now specify an interaction mode that changes how the AI agent behaves. A Plan selector is available in the UI.
- Adds a custom select component for compose-area dropdowns (tool, model, effort, thinking selectors) replacing native `<select>` elements for better mobile and desktop styling.
- Improves mobile disclosure and control layout: better touch handling, keyboard-adaptive layout, and polished sidebar disclosure behavior.
- Adds spinning gear + pulsing label animation to running thinking blocks, making active agent reasoning visually distinguishable even when the block is collapsed.
- Surfaces running assistant stream updates before full completion, so users see partial output as the agent works.
- Adds phase-0 realtime refresh telemetry instrumentation for monitoring delta transport health.

## v0.3.1

- Fixes mobile keyboard layout so the shell behaves as stable header + content + composer rows.
- Removes a mobile horizontal overflow regression caused by a stale fixed negative margin on the composer resize handle.
- Keeps viewport-driven layout ownership centralized to reduce resize conflicts and future mobile compatibility risk.

## v0.3.0

- Adds a clearer user-facing `Ver x.y.z` build label while keeping commit and frontend fingerprint data available for debugging.
- Splits frontend/page version identity from backend/service identity so the UI reports the code actually on screen.
- Switches frontend freshness detection from timer polling to push-only WebSocket invalidation.

## v0.2.0

- Consolidates the repo around the current HTTP-first RemoteLab architecture.
- Treats the current product shape as the new stable baseline after `v0.1`.
- Adds stronger session organization, restart recovery, sharing, and external channel work.
- Moves scenario-style validation scripts into `tests/` to keep the repo root cleaner.
- Templates Cloudflare email-worker config so personal deployment values do not need to ship in git.
