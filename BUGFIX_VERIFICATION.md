# Bug Fix Verification

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
