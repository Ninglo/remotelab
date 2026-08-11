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

---

## Feishu document capability multi-Bot credential isolation

### Bug Description

Every Feishu connector registered `document_get` under the same channel-level
entry. Starting Bot B overwrote Bot A's endpoint and callback token, so an agent
session originating from Bot A could invoke Bot B's document credentials.
Stopping Bot B also removed the shared channel entry while Bot A was still live.

### Step 1: RED - Reproduce Bug

- [x] Added `tests/test-connector-multi-route-skill.mjs` with two authenticated
  connector endpoints and a RemoteLab session sourced from Bot A.
- [x] Confirmed Bot A's direct call reached Bot B before the fix.

Failure evidence:

```text
AssertionError: bot A calls must retain bot A credentials
'bot-b' !== 'bot-a'
```

### Step 2: GREEN - Fix Applied

- [x] Connector registrations are stored per channel and `sourceRouteId`.
- [x] The CLI resolves the current request/session source context and routes to
  the originating Feishu Bot; that identity overrides a manual route argument.
- [x] Multi-route calls without source identity fail closed while single-route
  calls retain backward compatibility.
- [x] Deregistration removes only the matching Bot route.
- [x] Cross-process mutations use an atomic registry lock so simultaneous Bot
  processes do not lose each other's registrations.

Success evidence:

```text
test-connector-multi-route-skill: ok
All connector skill registry tests passed
test-feishu-document-skill: ok
```

### Step 3: REFACTOR - Clean Up

- [x] The existing `remotelab connector call feishu:document_get` agent command
  remains unchanged for normal Feishu sessions.
- [x] Legacy single-route registry entries remain readable.
- [x] Full `npm test` and `npm run test:integration` suites pass.
- [x] `npm run lint:filesize` and `git diff --check` exit successfully.
- [x] `npm audit --omit=dev` reports 0 vulnerabilities.

### Final Verification

- [x] Existing Feishu messaging, topic routing, document reads, system prompts,
  Bot registry operations, and unrelated connectors remain green.
- [x] Pre-existing unrelated memory, credential, and generated report files are
  excluded from the task commit.

**Fixed by:** Harness Agent
**Date:** 2026-08-01

---

## Bug Description

`scripts/chat-instance.sh sync --instance-root ...` left `INSTANCE_HOME` at the
operator's real HOME unless `--home` was also supplied. When the sync source did
not contain `.codex/auth.json`, `mirror_file` then deleted the operator's real
Codex auth file. The smoke test exercised this path while still reporting
success.

## Step 1: RED - Reproduce Bug

- [x] Regression test updated at: `tests/test-chat-instance-sync.mjs`
- [x] Test uses a disposable operator HOME
- [x] Test failed before the production fix

Command:

```text
node tests/test-chat-instance-sync.mjs
```

Evidence of failure:

```text
Error: ENOENT: no such file or directory, open '/tmp/remotelab-chat-instance-sync-DUJBIy/operator-home/.codex/auth.json'
    at readFileSync (node:fs:441:20)
    at file:///home/ubuntu/.remotelab/workspace/remotelab-feishu-v2-merge/tests/test-chat-instance-sync.mjs:71:5
  code: 'ENOENT'
```

The exact RED output is also preserved in `BUG_EVIDENCE.md`.

## Step 2: GREEN - Fix Applied

- [x] Code fixed at: `scripts/chat-instance.sh`
- [x] `--instance-root` now becomes the runtime HOME unless `--home` is explicit
- [x] A missing source auth file is now a non-destructive no-op
- [x] Isolated auth still copies into `<instance-root>/.codex/auth.json`
- [x] Focused test now passes

Evidence of success:

```text
$ node tests/test-chat-instance-sync.mjs
test-chat-instance-sync: ok
```

## Step 3: REFACTOR - Clean Up

- [x] Renamed the helper to `mirror_file_if_present` so its safety contract is explicit
- [x] Updated command help for the `--instance-root` HOME behavior
- [x] `bash -n scripts/chat-instance.sh` passed
- [x] `git diff --check` passed
- [x] `npm run lint:filesize` exited 0 with the repository's existing oversized-file report
- [x] `npm audit --omit=dev` reported 0 vulnerabilities

## Full Regression

```text
$ npm test
...
test-chat-instance-sync: ok
...
test-user-shell-env: ok
test-usage-summary-command: ok
test-connector-gmail: ok
FULL_TEST_EXIT=0
```

```text
$ npm run test:integration
test-http-session-templates: ok
test-http-session-media-upload: ok
test-http-file-assets: ok
test-http-result-file-assets: ok
test-http-voice-cleanup: ok
```

## Live Auth Safety Check

After the focused test and repeated full regression runs:

```text
Logged in using ChatGPT
inode=553773 size=4447 mode=600 mtime=2026-08-02 06:59:37.861944662 +0000
auth_path_audit_records=2
lost 0
```

The auth inode and mtime remained unchanged. The two exact-path audit records
are the original pre-fix deletion and the subsequent login recreation; the
post-fix test runs added no auth write or delete event.

## Final Verification

- [x] Regression test proves the destructive behavior existed
- [x] Focused and full tests pass
- [x] Static checks pass
- [x] Real Codex login remains intact
- [x] Unrelated pre-existing worktree changes were preserved and excluded from this fix

**Fixed by:** Harness Agent

**Date:** 2026-08-02

---

## GitHub Actions detached-runner timeout

### Bug description

GitHub-hosted runners are placed in a system service cgroup, so RemoteLab's
runtime detection selected `systemd-run`. The runner account cannot create a
transient system service, and the fallback path made the auto-compaction
integration test exceed its 20-second deadline.

### RED evidence

- GitHub Actions run `31424285984` failed in `tests/test-auto-compaction.mjs`.
- The log reported `Failed to start transient service unit: Interactive
  authentication required`, followed by `Timed out: overflow session should
  auto-compact after exceeding the context window`.

### Fix

The CI job sets `REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER=1`, selecting the
existing unprivileged detached-process launch mode. Production launch-mode
detection remains unchanged.

### GREEN evidence

- [x] `test-auto-compaction` passes on the detached-process path.
- [x] `test-session-follow-up-queue` passes on the detached-process path.
- [x] Full local `npm test` suite passes.
- [x] GitHub Actions run `31424937617` passes for commit `f98414b`.
- [x] `git diff --check` and file-size lint pass; the report contains only the
  repository's existing oversized-file baseline.

---

## Numeric Feishu Wiki space ID CLI coercion

### Bug description

The generic connector CLI coerced every digits-only option to a JavaScript
number. Real Feishu Wiki space IDs are digits-only string identifiers, so
`--space-id 7650536094013852860` lost both its string type and integer precision;
the Wiki skill then rejected it as missing.

### RED evidence

- The deployed `wiki_node_get` resolved the target Wiki successfully.
- The following formal connector call failed with `wiki_parameters_invalid` and
  `spaceId is required`: `wiki_children_list --space-id 7650536094013852860`.
- The regression case in `tests/test-feishu-wiki-skill.mjs` failed with exit
  code `1` before the fix.

### Fix and GREEN evidence

- Connector CLI values are now coerced according to each registered skill's
  parameter schema; string identifiers stay strings while numeric and boolean
  parameters retain their declared types.
- The regression uses the real numeric-looking Wiki space ID and passes.
- Focused connector/Wiki tests and the full local `npm test` suite pass.

---

## Fork a topic while the parent session is running

### Bug description

When a Feishu topic arrived while its parent group session still had an active
run, the formal `POST /api/sessions/:id/fork` route rejected the request with
HTTP 409. The connector then followed its explicit fresh-session fallback, so
the topic session lost its parent lineage and completed history.

### RED evidence

- `tests/test-session-forking.mjs` failed because the run manifest had no
  stable pre-run boundary: `undefined !== 2` for `forkBaseSeq`.
- After adding the core boundary logic, the HTTP regression still failed with
  `409 !== 201`, proving the formal connector route retained a second running
  session guard that the earlier implementation had missed.

### Fix

- Each run manifest now records the history sequence and context head captured
  before the active user turn begins.
- History and prepared fork context can be bounded to that recorded sequence.
- A running parent forks from this immutable boundary, excluding the active
  user message and all in-flight output while preserving completed history.
- The HTTP fork route now delegates this decision to `forkSession` instead of
  rejecting all running parents before the stable-boundary logic can run.

### GREEN evidence

- [x] `node tests/test-session-forking.mjs`
- [x] `REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER=1 node tests/test-http-runtime-phase1.mjs all`
- [x] Connector, Feishu topic-fork, and Feishu connector focused tests
- [x] Full `REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER=1 npm test` suite
- [x] `npm run test:integration`
- [x] `npm run lint:filesize` and `git diff --check`

**Date:** 2026-08-11
