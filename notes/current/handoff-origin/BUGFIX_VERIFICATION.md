# Handoff child origin verification

Date: 2026-09-15

## Problem and change

An independent handoff copied the parent's `sourceId` / `sourceName` without
creating an external conversation. A Feishu parent therefore produced a child
that was hidden by the Chat UI origin filter and had no Feishu topic to return to.

`delegateSession` now creates a Chat UI session. Existing visible delegated
sessions with no conversation, source context, external trigger or completion
target receive the same origin repair when metadata is loaded. Internal and
visitor sessions are excluded. Identity, lineage, history and archive state stay
intact. Connector-driven topic forks use their existing routing path.

## RED

Tests were added and run before the implementation change:

- `test-http-session-spawn-recursive.mjs`: failed at
  `unbound handoff sessions must appear under Chat UI origin`, with
  actual `feishu`, expected `chat`.
- `test-session-delegation-origin.mjs`: failed at
  `repair only the inherited origin; keep history identity, lineage, timestamps and archive state`,
  with actual `sourceId: feishu, sourceName: Feishu`, expected `chat, Chat`.

## GREEN and review

- HTTP + CLI fake-runtime scenario passed: three visible children have Chat UI
  origin in list/detail responses, retain runtime selection and parent handoff,
  execute their own task, and inherit no connector context or routing key.
  The parent keeps its Feishu origin.
- Stored-metadata regression passed: active, archived and email-origin children
  are repaired durably and idempotently. Bound, triggered, internal, visitor and
  non-delegated records are preserved.
- All commands in `npm test` completed successfully across the initial run and
  continuation. The initial run stopped at a startup timeout in
  `test-http-session-patch-runtime-preferences.mjs`; a diagnostic rerun with
  child-server output passed, followed by the remaining 58 commands, including
  connector recovery and async delivery suites. The initial timeout's cause
  was not reproduced, so this is not a claim of one uninterrupted green run.
- `npm run test:restart-gate` passed.
- `npm run lint:filesize` exited 0; it still reports repository-wide existing
  oversized files. No unrelated size cleanup was included.
- Syntax checks for changed JavaScript and `git diff --check` passed.

Tests used isolated temporary instance state. Existing unrelated working-tree
changes were preserved and excluded from this commit. The tested source remains
runnable; production readback is a separate deployment check.
