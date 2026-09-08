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
