# Bug Fix Verification

## PR #21 Feishu Topic Metadata CI Regression

### Bug Description

`enrichSummaryWithChatMetadata` treated a present `chatName` as proof that topic
mode metadata was already complete. Normal group-message payloads that included
the chat name but omitted `groupMessageType` and `chatMode` therefore skipped
the cached chat metadata lookup and generated a group-scoped trigger instead of
a topic-scoped trigger.

### Step 1: RED - Reproduce Bug

- [x] Existing regression scenario at `tests/test-feishu-connector.mjs:1632`
  covers a payload with `chatName` but without the two topic mode fields.
- [x] GitHub Actions run `30155661717` failed on that scenario before the fix.

Failure evidence:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ 'feishu:group:chat_topic_metadata_1'
- 'feishu:topic:chat_topic_metadata_1:msg_topic_metadata_test_1'
at tests/test-feishu-connector.mjs:1643:10
```

### Step 2: GREEN - Fix Applied

- [x] Metadata enrichment now short-circuits only when `groupMessageType` or
  `chatMode` is present; `chatName` no longer suppresses topic metadata lookup.
- [x] The focused Feishu connector regression test passes.

Success evidence:

```text
ok - topic metadata from chat metadata fallback enables topic-scoped sessions
```

### Step 3: REFACTOR - Clean Up

- [x] The change is limited to the incorrect short-circuit condition.
- [x] Full `npm test` suite passes.
- [x] `npm run lint:filesize` exits successfully.
- [x] Task changes pass `git diff --check`.

### Final Verification

- [x] Existing unrelated machine-local memory, credentials, and generated
  reports remain outside the task commit.
- [x] The regression remains covered by the existing smoke suite.

**Fixed by:** Harness Agent
**Date:** 2026-07-25

---

## Bug Description

Feishu Bot operations did not preserve two legacy single-Bot behaviors:

1. macOS LaunchAgent ownership was not discovered, so restart could treat a
   launchd-managed connector as a direct process.
2. A single valid Bot outside the legacy default config path was not selected
   automatically when no `--bot` or `--config` selector was provided.

## Step 1: RED - Reproduce Bugs

- [x] Regression tests added to `tests/test-feishu-bot-registry.mjs` and
  `tests/test-feishu-ops.mjs`.
- [x] Both tests failed before the implementation.

Failure evidence:

```text
SyntaxError: The requested module '../lib/feishu-bot-registry.mjs' does not provide an export named 'parseFeishuLaunchdPlist'
```

```text
TypeError: resolveRegisteredBot is not a function
```

## Step 2: GREEN - Fix Applied

- [x] LaunchAgent property lists and launchctl runtime state are discovered and
  bound to their exact config.
- [x] LaunchAgent restart uses `launchctl kickstart -k`, retaining unload/load
  as a compatibility fallback.
- [x] No-selector operations prefer the valid legacy `default` Bot, then fall
  back to exactly one valid discovered Bot.
- [x] Explicit selectors and multi-Bot ambiguity remain fail-closed.

Success evidence:

```text
feishu bot registry tests passed
ok
```

## Step 3: REFACTOR - Clean Up

- [x] Runtime-owner output includes launchd labels.
- [x] Documentation and changelog updated.
- [x] Full `npm test` suite passes.
- [x] `npm run lint:filesize` exits successfully; existing oversized-file
  warnings remain non-blocking.
- [x] `npm audit --audit-level=high` reports 0 vulnerabilities.
- [x] `npm pack --dry-run --json` succeeds.

## Final Verification

- [x] The live Linux default Bot remains bound to its exact systemd unit and PID.
- [x] Task changes pass `git diff --check`.
- [x] Pre-existing unrelated memory and report changes remain outside the task.

**Fixed by:** Harness Agent
**Date:** 2026-07-23
