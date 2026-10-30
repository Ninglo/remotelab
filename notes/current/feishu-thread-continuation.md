# Feishu topic conversation and continuation

Status: updated 2026-10-30 from the thread invitation and mute feedback.

## Product contract

An explicit Bot mention in an ordinary-group thread is a direct request. It
requires no group setting, participation selection or status card. Once the
conversation binds, human follow-ups continue in its Session without another
mention. Native topic groups receive human messages by default. New uninvited
ordinary-group conversations still follow their exact-chat admission policy;
self messages and uninvited peer Bots remain excluded.

Mainline and thread reception are independent. Each thread starts active and
only its own explicit mute pauses reception. Mainline defaults, mute/resume,
control revisions and cancellation do not propagate to threads. Legacy
inherited thread records (`modeOverride: false`) no longer constrain reception;
explicit thread mute remains durable across restarts. A mention while explicitly
muted still receives a single reply and leaves that scope muted.

Listening is retired. Old explicit listening states become paused without
collecting observations or attachments. The normal thread prompt directs the
Harness to answer human inputs and continue accepted work, with no mainline
participation gate. Current prompts update on the next accepted input; already
accepted execution snapshots remain historical.

## Implementation

- `group-settings.mjs` recognizes native topics, thread/topic IDs and normalized
  topic conversation kinds. Native topic groups or exact-chat opt-in select intake `all`;
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
