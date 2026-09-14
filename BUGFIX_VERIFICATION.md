# Origin filter verification — 2026-09-14

Problem: background session refresh rebuilt native select options and restored the old selection before change could commit, leaving the session list unfiltered. A duplicate global origin value and render-time clearing of empty origins added inconsistent state paths.

## RED

`node scripts/run-with-clean-instance-env.mjs node tests/test-chat-sidebar-filter-interaction.mjs`

Initial result: 6 tests, 1 passed, 5 failed. The refresh race reported actual `__all__`, expected `chat_ui`. No-op option identity, focused count refresh, selected zero-count preservation and Store-driven filtering also failed. The deployed page reproduced All=62, Chat=3, race result=62 with no pageerror.

## GREEN

Final result: 8 tests, 8 passed. Existing origin options and visibility tests and split-frontend smoke passed. Full `npm test` exited 0. `git diff --check` passed. File-size reporting exited 0 with existing repository warnings.

Actual-domain Chromium checks: desktop and mobile viewports each passed 60 selections, 30 interleaved refreshes and 40 no-op refreshes (0 option DOM mutations); keyboard selection, persistence on reload and no pageerrors. The same race now returns Chat=3. Four changed assets match checkout byte-for-byte. No Safari-native UI acceptance is claimed.

Implementation analysis: [Session origin filter](notes/current/session-origin-filter.md).

Only the filter implementation, tests, package gate and these notes belong to this change. Pre-existing backend/model/composer edits remain outside it. Frontend assets are read from source and fingerprinted independently of the running service's startup commit; no backend restart is needed for these changes.
