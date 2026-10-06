# Feishu topic conversation and continuation

Status: clarified 2026-10-06 after recovering a missed work-topic request and
reviewing earlier per-group decisions. Work/learning entry points use exact-chat
opt-in; sharing and newly joined groups keep passive defaults.

## Product contract

Groups and their uninvited topics require an explicit Bot mention or command
unless that exact chat has
`participationMode: "ambient"` or `responseMode: "all"`. Connector-wide settings,
including legacy `all`, do not enable proactive participation in other groups.
Creating or joining a group never opts it in. After an accepted invitation or
an outbound-created conversation binds a topic, later human follow-ups need
no additional mention. Other topics do not inherit that invitation. Admitted
topics receive direct-conversation instructions. Explicit mute,
listening and paused controls remain effective.

A work or learning topic group intended to receive assistant tasks must have
its own `responseMode: "all"`. Sharing groups retain `mention_only`; native
topic metadata alone never overrides that distinction. Review actual group
purpose and prior decisions instead of assuming every topic group is a work
entry point. Keep existing automated workflows and explicitly enabled
discussion groups separate from new, unconfigured groups.

The earlier blanket topic policy fixed a plain question under an automated
report, but also admitted uninvited new topics. The latest operator instruction
requires passive defaults across groups. A report-created topic without an
accepted Bot conversation now needs an explicit invitation. Bound report
topics continue normally. Topic prompts remain distinct from mainline observer
instructions.

If a missing group opt-in filtered a real request before Session creation,
recover the original sender and source message through the native connector
submission path. The normal opening includes the accepted model, effort,
Harness and Session link and stays in that original topic. The Session belongs
to the original sender's workspace. Delegating from the repair operator's
Session does not recover the original attribution or delivery route.

## Implementation

- `group-settings.mjs` recognizes native topics, thread/topic IDs and normalized
  topic conversation kinds. Only exact-chat opt-in selects intake `all`;
  admitted topics retain instructions to reply to each human message.
- `response-policy.mjs` retains sender, self, peer-Bot and mute guards, and
  filters uninvited groups and new topics before any model submission.
  A scoped Session binding permits normal topic continuation.
- `handleMessage` awaits this decision before commands, reactions, attachment
  handling or Request submission. Inbox access control still runs first.
- `session-flow.mjs` uses the same canonical topic identity as Session routing:
  thread ID, topic ID, or native topic-mode root identity. Bare group reply/quote
  parent IDs never constitute topic identity.
- Binding lookup still requires exact Bot, tenant, chat and topic scope when
  selecting the Session and admitting unmentioned follow-ups.
- Inbound acceptance and outbound delivery receipts already record bindings,
  so continuation preserves the associated Session across connector restarts.
  A failed submission does not create a binding or activate later plain replies.
- Topics do not use ambient or reaction-only quick-participation instructions.
  Forwarded mainline messages require the same per-chat opt-in or explicit
  invitation as text. Forwarded messages inside bound topics reach their Session.

## Regression verification

`tests/test-feishu-response-policy.mjs` covers exact-chat work/learning opt-in
with missing event metadata, sharing exceptions, passive new topics and invited
topic continuation, per-chat opt-in, topic-specific prompts, another human in
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
