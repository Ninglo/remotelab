# Connector Binding Fallback Hardening Verification

## Bug Description

Email actions could synthesize a mailbox binding when the requested binding was missing or unknown. Inbound mail without a resolvable recipient could fall back to the owner mailbox identity. Calendar completion actions without a valid external binding could silently write to the local iCal feed and appear ready.

During code review on 2026-09-06, the removal of synthetic email bindings exposed a bootstrap regression: a freshly initialized mailbox, or an existing mailbox seen at server startup before processing inbound mail, did not persist its explicit email binding. Its ready Agent Mailbox could therefore disappear from the projected connector catalog.

## Step 1: RED - Reproduce Bugs

- [x] Missing and unknown email binding coverage added to `tests/test-session-connector-state-surface.mjs`.
- [x] Missing external calendar binding coverage added to `tests/test-connector-action-dispatcher.mjs`.
- [x] Missing and unrecognized inbound recipient coverage added to `tests/test-agent-mailbox.mjs`.
- [x] Tests failed before the implementation changes.

### Failure evidence

```text
AssertionError [ERR_ASSERTION]: missing email bindings must not be synthesized from a mailbox root
+ actual - expected
+ { capabilityState: 'binding_required', connectorId: 'email', ... }
- null
```

```text
AssertionError [ERR_ASSERTION]: should not synthesize a compatibility email binding

1 !== 0
```

```text
AssertionError [ERR_ASSERTION]: Missing expected rejection: mail without a resolvable recipient must not fall back to the owner mailbox identity
```

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ 'ready'
- 'binding_required'
```

The review follow-up tests also failed before the bootstrap fix:

```text
AssertionError [ERR_ASSERTION]: mail init must persist the explicit email binding immediately
actual: null
```

```text
AssertionError [ERR_ASSERTION]: server startup must persist the explicit email binding even when mailbox automation is disabled
actual: null
```

## Step 2: GREEN - Fix Applied

- [x] Connector binding lookup now returns only explicitly stored email bindings and does not fall back after an unknown binding id.
- [x] Email delivery stops before transport dispatch when the requested binding cannot be resolved.
- [x] Inbound email ingestion rejects missing or unmappable recipients instead of deriving the owner identity.
- [x] Calendar completion actions require an external binding and authorization; the local iCal feed remains available only through its explicit feed action.
- [x] `mail init` now persists the explicit email binding immediately.
- [x] Server startup bootstraps a binding for an existing mailbox before checking whether inbound mailbox automation is enabled.
- [x] Targeted tests pass.

### Success evidence

```text
test-connector-action-dispatcher: ok
test-session-connector-state-surface: ok
agent mailbox tests passed
agent mail reply tests passed
test-system-prompt-gmail: ok
test-agent-mail-command: ok
embedded mail worker disable flag and binding bootstrap tests passed
```

## Step 3: REFACTOR - Clean Up

- [x] Removed the compatibility email binding synthesis path.
- [x] Removed calendar completion dispatcher's implicit feed fallback.
- [x] `git diff --check` passes.
- [x] Changed JavaScript modules pass `node --check`.
- [x] Repository file-size lint command completes; its existing baseline warnings remain unchanged in kind.
- [x] Full `npm test` suite passes.

## Final Verification

- [x] Code is runnable and the full configured test suite passes.
- [x] `git diff --check`, changed-module syntax checks, and the repository file-size report complete; the file-size report still shows the pre-existing baseline warnings.
- [ ] The working tree also contains an unrelated `memory/auto-system-memory.md` change, which must be excluded or reviewed separately before committing this connector slice.
- [ ] Changes are committed or deployed; neither action was authorized for this review.

**Fixed by:** Harness Agent
**Date:** 2026-09-05

## Submission follow-up — 2026-09-08

The owner subsequently authorized submitting all remaining local changes. The
connector diff, tests and existing auto-system-memory additions were reviewed
together; the latter are project guidance, with no credentials or private paths
in the added lines. The earlier unchecked submission items describe the prior
review boundary, not the current authorization. No live service restart or
external mail/calendar delivery is part of this submission.

## Feishu fork marker — 2026-09-10

A rich-text leading mention becomes `@Task Bot`, while the old command parser
only removed `@_user_1` tokens and required `/fork` at the beginning. The owner
requested a simpler contract: a case-insensitive `/fork` anywhere in a group
message starts a fresh task. The marker is removed and the other text is kept.
Literal discussion of the marker also triggers a fork; ordinary access rules,
private-chat routing and Bot handoff limits are unchanged.

### RED

Added the raw rich-text fixture and marker cases to
`tests/test-feishu-runtime-commands.mjs`, plus mocked HTTP admission coverage in
`tests/test-feishu-topic-fork.mjs`. Both failed before implementation:

```text
AssertionError [ERR_ASSERTION]: a rich-text mention must not hide the fork marker
+ actual - expected
+ null
- {
-   text: '@Task Bot  discover datasets\nkeep the original table intact',
-   type: 'fork'
- }

AssertionError [ERR_ASSERTION]: a fork marker overrides the existing thread and continue policy
12 !== 13
```

### GREEN and review

- Both regressions pass. The integration test verifies new Session creation,
  fork routing, preserved task text and thread reply delivery despite an existing
  thread binding and Continue policy.
- Connector, runtime-command, topic-fork, response-policy, mute and Bot-handoff
  focused suites pass. An offline replay of the incident's received message
  also recognizes the marker and preserves the remaining task text.
- Full `npm test` completed with exit 0.
- Changed JavaScript files pass `node --check`; `git diff --check` passes.
- `npm run lint:filesize` exits 0 with the existing advisory oversized-file
  report. No new module or parser compatibility layer was introduced.
- Help text and setup documentation describe the marker and its intentional
  behavior when quoted or combined with another command.
- Verification used isolated tests and mocked HTTP transport; it did not resend
  the original message or post external test messages.

## Feishu prose `/fork` false-positive — 2026-09-12

The 2026-09-10 marker behavior was too broad for normal conversation. A
message discussing the command (for example, “包括 `/fork` 之类”) matched the
message-wide detector, set `forkCommand`, bypassed the existing thread binding,
and created a fresh Session. The existing thread binding itself was present;
the new Session was caused by command classification, not by a lookup failure.

### RED

Added regressions for prose mentioning `/fork` and for a bound topic receiving
that prose. Before the fix, the parser returned `{ type: 'fork' }` for the prose
case:

```text
AssertionError [ERR_ASSERTION]: mentioning /fork in prose must not create a new task Session
actual: { text: 'connector 命令易用性可能设计下，比如消息里带上很多命令（包括  之类）。', type: 'fork' }
expected: null
```

### GREEN

- `/fork` is now recognized only at the start of a message line, optionally
  after a leading connector mention; ordinary prose and nested command text do
  not trigger it.
- A bound topic containing the prose mention reuses its existing Session; the
  integration regression asserts that no new Session is created.
- Existing explicit fork, rich-text mention and trailing command-line cases
  remain covered.
- Targeted runtime-command and topic-fork tests pass. The full suite and
  restart gate pass; changed-module syntax, whitespace and advisory size
  checks also pass.
- No live connector restart, binding edit or external test message was used.
