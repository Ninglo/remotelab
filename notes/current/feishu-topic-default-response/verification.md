# Feishu topic groups respond by default

## Product contract

Native Feishu topic groups admit every human message by default. A topic is an
intentional conversation surface, so users do not need to mention the Bot again
to begin or continue work there. Ordinary group timelines remain
`mention_only` by default.

Exact `groups[chatId].responseMode` configuration remains authoritative. It can
narrow a topic group to `mention_only` or widen an ordinary group to `all`.
Bot-originated messages still require an explicit mention, conversation mute
still applies, and self-message loop protection remains unchanged.

## Verification

`tests/test-feishu-response-policy.mjs` covers default admission in native topic
groups, the unchanged mention gate for an ordinary group Thread, and an exact
chat override narrowing a topic group. The existing suite continues to cover
private messages, global `all`, durable invited-Thread continuation, mutes, Bot
handoffs, sender isolation and restart persistence.

On 2026-09-22, the focused response-policy, mute, connector, Bot-handoff and
reply-routing tests passed. The complete `npm test` suite also passed, including
connector recovery, asynchronous delivery and document-binding coverage.
