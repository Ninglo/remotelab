# Feishu policy simplification — 2026-09-08

## Contract

Feishu message admission has two policy dimensions:

- `accessPolicy.mode`: `all` by default, or `whitelist` using explicit sender IDs.
- `responsePolicy.group`: `all` or `mention_only` for the whole Bot.

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
- Live config migration, restart and reaction verification are recorded during
  deployment.
