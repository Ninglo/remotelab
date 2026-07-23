# Changelog

## Unreleased

- Adds Feishu Bot discovery and a secret-free registry, with config-bound `status` and `restart` operations that target the exact process, systemd unit, or macOS LaunchAgent while preserving single-Bot default selection.
- Keeps the shipped owner flow centered on sessions and settings after retiring the unused planning surface.
- Removes the last hidden web voice-cleanup path so the composer now sends text directly.
- Keeps session workflow organization derived from `workflowState`, `workflowPriority`, review state, and live activity instead of a parallel planning surface.

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
