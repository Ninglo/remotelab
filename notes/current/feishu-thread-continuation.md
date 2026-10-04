# Feishu topic conversation and continuation

Status: topic admission revised 2026-10-04. This replaces the 2026-09-08
requirement for an invitation before the first ordinary-group Thread message.

## Product contract

Every human message in a Feishu topic is addressed to the assistant by default
and receives a reply without an @ mention. This applies both to native topic
groups and to Threads in ordinary groups, including the first reply under a
report-script message that has not yet been bound to a Session. Existing group
mention settings no longer discard human messages. Every admitted, unmuted
mainline message also reaches a Session, which decides whether a useful reply
or task is needed. Legacy mention-only mainlines use a continuing observation
Session, while topics receive direct-conversation instructions. Explicit mute,
listening and paused controls remain effective.

The reported failure was a plain question under an automated report: durable
ingress recorded it, but response policy rejected it before creating a Request.
There was no model judgment or outbound delivery to diagnose for that input.
Topic Sessions must receive topic-specific reply instructions rather than
the mainline instructions that let a group observer stay silent.

## Implementation

- `group-settings.mjs` recognizes native topics, thread/topic IDs and normalized
  topic conversation kinds. Topic intake is `all` regardless of the group's
  mainline response override, with instructions to reply to each human message.
- `response-policy.mjs` retains sender, self, peer-Bot and mute guards; every
  remaining human message reaches a Session. A binding is no longer required.
- `handleMessage` awaits this decision before commands, reactions, attachment
  handling or Request submission. Inbox access control still runs first.
- `session-flow.mjs` uses the same canonical topic identity as Session routing:
  thread ID, topic ID, or native topic-mode root identity. Bare group reply/quote
  parent IDs never constitute topic identity.
- Binding lookup still requires exact Bot, tenant, chat and topic scope when
  selecting the Session. It controls continuity, not whether a human can speak.
- Inbound acceptance and outbound delivery receipts already record bindings,
  so continuation preserves the associated Session across connector restarts.
  A failed submission does not create a binding or prevent a later plain reply.
- Topics do not use ambient or reaction-only quick-participation instructions.
  Forwarded messages on both the mainline and inside topics reach the Session.

## Regression verification

`tests/test-feishu-response-policy.mjs` covers first and subsequent mention-free
topic messages, mainline overrides, topic-specific prompts, another human in
the same thread, restart persistence, binding scope isolation, topic aliases
and native root fallback, outbound-created threads, recovery after failed
submission, mainline quotes and suppression of unmentioned Bot/self messages.
`tests/test-feishu-connector.mjs` covers topic and mainline merge-forwards and
native topic metadata fallback. These files are in the smoke suite.

Run targeted checks using `scripts/run-with-clean-instance-env.mjs`:

- `tests/test-feishu-response-policy.mjs`
- `tests/test-feishu-connector.mjs`
- `tests/test-feishu-bot-handoff.mjs`
- `tests/test-feishu-mute.mjs`
- `tests/test-feishu-ambient-participation.mjs`
- `tests/test-feishu-jev-reactions.mjs`

These checks use isolated state and do not inject synthetic messages into live
chats. A source commit or test pass is not live rollout evidence: verify the
active connector processes and policy, then retain an actual human topic
Request and reply receipt when one occurs.
