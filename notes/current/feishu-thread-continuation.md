# Feishu invited-thread continuation

Status: implemented 2026-09-08; rollout verification below.

## Product contract

Under `responsePolicy.group = mention_only`, an explicit mention invites this
Bot into a conversation. Once an exact thread is bound to this Bot's Session,
subsequent human replies in that thread do not need another mention. New threads
and ordinary group messages remain mention-gated. Private chat and explicit
`group = all` behavior remain unchanged. This refines the earlier every-message
mention rule recorded in `feishu-policy-simplification/BUGFIX_VERIFICATION.md`;
it does not restore a third policy dimension or per-chat overrides.

## Implementation

- `response-policy.mjs` checks a durable thread binding only after explicit
  mention/all/private shortcuts and the existing sender/Bot guards.
- `handleMessage` awaits this decision before commands, reactions, attachment
  handling or Request submission. Inbox access control still runs first.
- `session-flow.mjs` uses the same canonical topic identity as Session routing:
  thread ID, topic ID, or native topic-mode root identity. Bare group reply/quote
  parent IDs never constitute thread participation.
- Binding lookup requires an actual binding direction and an exact chat/topic
  scope inside the Bot's own message-index file. Existing production bindings
  remain valid; no config or state migration is required.
- Inbound acceptance and outbound delivery receipts already record bindings,
  so continuation preserves the associated Session across connector restarts.
  A failed submission does not create a binding.

## Regression verification

`tests/test-feishu-response-policy.mjs` covers invitation, mention-free follow-up,
another human in the same thread, restart persistence, group/thread/tenant/Bot
isolation, topic aliases and native root fallback, outbound-created threads,
failed submissions, nonactivating group sessions/quotes/@all/other mentions,
and suppression of unmentioned Bot/self messages. This file is in the smoke suite.

Targeted runs passed using `scripts/run-with-clean-instance-env.mjs`:

- `tests/test-feishu-response-policy.mjs`
- `tests/test-feishu-topic-fork.mjs`
- `tests/test-feishu-connector.mjs`
- `tests/test-feishu-bot-handoff.mjs` (concurrently developed Bot guard integration)

No synthetic message was injected into a live chat or submitted to an AI during
these tests. Live validation will use read-only policy probes and connector
startup logs; a real human follow-up remains the end-to-end acceptance check.
