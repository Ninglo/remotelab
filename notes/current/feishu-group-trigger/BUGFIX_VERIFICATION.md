# Feishu group trigger mitigation — 2026-09-07

## Problem and scope

An operator reported that ordinary conversation in a specific group triggered AI
replies. Sender access (`intakePolicy: allow_all`) was the only inbound filter in
the running main revision. Commit `b1574763` had implemented group routing on a
separate branch, but was not an ancestor of main (`91716eeb`). The earlier fix was
therefore absent from the active main deployment, rather than a working toggle
being changed by the operator.

Restore an explicit `groupReplyPolicy` transport filter with `all` and
`mention_only`, plus `chatModes` overrides so this mitigation can target one group.
Keep existing behavior for unconfigured groups and private messages. Defer automatic
thread continuation and the broader collaboration design. This is a deterministic
intake filter, before commands, processing reactions, resource hydration and AI
submission; replay reaches the same filter. Identity comes from the Bot API with
a bounded startup lookup. Another user's mention, an existing thread or a stale
`mentionedBot` replay flag cannot enable a restricted group.

## Failure evidence

Before implementation, the scenario test reached reply generation for ordinary
group chatter despite an explicit mention-only configuration:

```text
AssertionError: ordinary group chatter must not trigger AI
true !== false
```

## Verification

- `node scripts/run-with-clean-instance-env.mjs node tests/test-feishu-group-routing.mjs`: passed.
  Covers ordinary chatter, another person/Bot, this Bot's IDs, Topics, existing
  threads, local commands, stale replay flags, missing identity, private chats,
  unaffected groups, explicit all mode and invalid configuration.
- `node scripts/run-with-clean-instance-env.mjs node tests/test-feishu-connector.mjs`: passed.
- `npm test`: passed, including the new routing regression in the smoke suite.
- `node --check` for both implementation modules and `git diff --check`: passed.
- `npm run lint:filesize`: completed successfully; its advisory report still flags
  pre-existing oversized files. No unrelated refactor was attempted.
- Live read-only Bot API lookup matched the target connector identity.
- Evaluated three stored real inbound events against the actual configured policy:
  ordinary chatter => blocked; mentioning another person => blocked;
  explicitly mentioning this Bot => accepted. No test messages were sent and no
  new AI requests were submitted by this check.
- Backed up the private connector config and set only the affected group's
  `chatModes` entry to `mention_only`.
- Restarted the affected connector at 2026-09-07 07:20:16 UTC. Systemd reports active;
  startup logs show the precise per-group policy and `ws client ready`.
- Preserved delivery of two existing in-flight requests with a temporary publication
  waiter, which reads their existing response IDs and does not resubmit tasks.

The post-restart evidence verifies loaded configuration and connectivity. New human
messages were not required for, or sent as part of, validation. Machine-local logs
are under `~/.remotelab/workspace/feishu-group-trigger-20260907/`.

## Main integration boundary

While publishing this fix, main advanced to `12213e27` with the durable connector
Inbox/Request refactor. The merge keeps the group filter ahead of local commands
and request submission in the new `handleMessage`, and adapts its scenario test to
observe admission rather than the retired reply-generation hook. Inbox replay
therefore observes the same restriction.

The production mitigation was activated on `32df5b72` using the current state
format. The separate request-store migration requires an offline conversion and
unfinished-executor disposition documented in `connector-request-recovery.md`.
That migration is not part of disabling automatic responses in one group; do not
restart the existing production instance on the new state format without completing
that conversion. Both source lines include the group trigger restriction.
