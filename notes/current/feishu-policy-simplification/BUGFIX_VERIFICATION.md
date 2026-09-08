# Feishu policy simplification — 2026-09-08

## Contract

Feishu message admission has two policy dimensions:

- `accessPolicy.mode`: `all` by default, or `whitelist` using explicit sender IDs.
- `responsePolicy.group`: `mention_only` by default, or explicit `all`, for the whole Bot.

Private messages always pass the response policy after sender access succeeds.
Every admitted AI request receives a fixed `THINKING` reaction before durable
submission. A reaction API failure is logged and does not drop the request.

Per-chat response overrides, configurable reaction behavior, silent confirmation
text, group approval commands, approved-chat state, membership grants and member
join handling were removed. Legacy policy keys fail at startup with a migration
error instead of silently changing behavior.

## RED

Before implementation, `tests/test-feishu-response-policy.mjs` observed
`['submit']` for ordinary group chatter under the requested `mention_only`
contract, instead of no side effects. The new processing-reaction assertion also
had no call site in `handleMessage` after the durable Inbox refactor.

## GREEN

- `tests/test-feishu-response-policy.mjs` covers group all/mention-only, private
  admission, exact Bot identity matching, reaction ordering, non-blocking reaction
  failure, defaults and rejection of all retired keys.
- `tests/test-feishu-connector.mjs` covers whitelist reload, request admission,
  `/fork`, media, Topics and delivery behavior after removal of approval state.
- `tests/test-feishu-comments.mjs` confirms document-comment routing remains intact.
- Full `npm test` passed after the final simplification, including merge-safety
  and connector crash-recovery suites.
- Syntax checks and `git diff --check` passed. `npm run lint:filesize` completed
  with its advisory baseline report; this change reduces
  `scripts/feishu-connector.mjs` by more than 500 lines.
- Both local configs were migrated with backups: primary uses `all/all`; bot-2
  uses `all/mention_only`. Retired keys are absent.
- Both systemd connectors restarted into new PIDs and report active/running.
  Startup logs show the expected policies and `ws client ready` for each Bot.
- A real bot-2 API call added a `THINKING` reaction to the message that requested
  this change and returned a Feishu reaction ID.

## Default correction — 2026-09-08

The owner requested mention-only groups for every Bot. The primary config was
backed up and changed to `mention_only`; bot-2 already used that value. Primary
reconnected with a fresh process and logged `response policy: {"group":"mention_only"}`
and `ws client ready`. Code defaults and CLI examples now also use `mention_only`.
The default-config regression failed with actual `all` before the fix and passed
after it. Tests cover omitted settings rejecting ordinary group messages while
admitting Bot mentions and private messages; explicit `all` remains supported.

Full `npm test` passed. Saved output: `/tmp/feishu-default-mention-20260908-test_results.txt`.
Selected actual output:

```text
Feishu access, response and processing acknowledgement tests passed
ok - whitelist file reloads without restart
process recovery: SIGKILL after admission and during execution, offline completion, exactly one attempt and persistent delivery receipt passed
```
