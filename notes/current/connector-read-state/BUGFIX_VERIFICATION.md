# Connector read-state display verification

Date: 2026-09-15

## Problem and change

External-origin conversations displayed unread `review` badges and used the
`is-complete-read` title style based on browser review timestamps. Those visits
do not establish whether a reply was read in its external application.

The Session state model now enables both effects only for Chat UI origin
(including legacy records without a source) with no external conversation
binding. Running indicators remain available for all origins. Chat UI handoffs
keep their own read indicators regardless of parent origin.

## RED → GREEN

Before the fix, the added regression failed with:

```text
AssertionError: feishu should not infer unread state from Web UI visits
true !== false
```

After the fix, `test-chat-session-state-model.mjs` passed. It covers eight external
source forms, read/unread snapshots, Chat UI and legacy defaults, independent
handoffs, external bindings with a stale Chat UI label, and running state.

## Verification

- Sidebar row metadata and all eight origin-filter interaction scenarios passed.
- Full `npm test` passed, including connector delivery and recovery regressions.
- `npm run test:restart-gate`, JavaScript syntax and `git diff --check` passed.
- `npm run lint:filesize` exited 0; existing repository-wide size warnings remain.
- Read the scripts actually served by the current instance and rendered real
  Session API data with those scripts in a minimal DOM harness: all 17 external
  rows omitted both read effects; both running external rows kept their running
  indicator. Chat UI unread rows retained their badges. This was a script/DOM
  check, not a real-browser screenshot test.

Unrelated working-tree changes are preserved and excluded from this commit.
