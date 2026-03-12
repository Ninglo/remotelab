# Changelog

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
