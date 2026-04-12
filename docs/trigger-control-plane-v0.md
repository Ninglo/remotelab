# Trigger Control Plane v0

RemoteLab now has a first server-owned trigger control plane for narrow deferred wake-ups.

This is intentionally small.
The goal is not to ship a general workflow engine or scheduler DSL.
The goal is to stop hiding automation policy inside prompts and standalone scripts when the platform needs a durable, inspectable, retryable wake-up primitive.

## Scope

v0 supports exactly one trigger shape:

- trigger type: `at_time`
- action type: `session_message`
- target: an existing RemoteLab session
- delivery: inject one canonical message into that session through the normal session/run pipeline

The system stays session-first:

- the trigger is a durable wake-up object
- delivery reuses the normal session message submission path
- resulting work still appears as ordinary session activity and run state

This is a deliberate v0 limitation, not a general reminder or notification model.
If an external message must be sent deterministically to a connector target such as WeChat, this v0 shape is not enough on its own because it only knows how to wake a session, not directly invoke a connector action.

## Why this exists

Before this slice, automation could be spread across:

- model self-initiative inside prompts
- standalone scripts with private cooldown / retry / dedupe logic
- external schedulers that knew how to create sessions and submit messages but were not first-class platform objects

That made automation hard to manage, inspect, and reverse-trace.

v0 fixes that by making trigger intent durable and queryable, while still keeping execution inside the existing session/run system.

## Trigger object

Stored under `~/.config/remotelab/chat-triggers.json`.

Current fields:

- `id`
- `triggerType` → `at_time`
- `actionType` → `session_message`
- `status` → `pending | delivering | delivered | failed | cancelled`
- `enabled`
- `title`
- `sessionId`
- `scheduledAt`
- `text`
- `tool`, `model`, `effort`, `thinking`
- `requestId`
- `createdAt`, `updatedAt`
- `deliveryAttempts`, `claimedAt`, `lastAttemptAt`, `nextAttemptAt`
- `deliveredAt`, `runId`, `deliveryMode`
- `lastError`, `lastErrorAt`

## Delivery semantics

The trigger scheduler runs inside `chat-server.mjs`.

For each due trigger:

1. claim it durably as `delivering`
2. submit the configured message through `submitHttpMessage()`
3. reuse stable `requestId = trigger:<triggerId>` for idempotency
4. append a visible session `status` event when delivery is newly accepted
5. mark the trigger as `delivered`

If delivery fails:

- transient failures retry with backoff
- permanent failures end as `failed`
- stale in-progress claims can be retried after timeout

If the target session is busy, delivery can still be accepted through the existing follow-up queue path.
In that case the trigger is considered delivered to the session system and records `deliveryMode = queued`.

## HTTP API

Owner-only routes:

- `GET /api/triggers`
- `GET /api/triggers?sessionId=<id>`
- `POST /api/triggers`
- `GET /api/triggers/:id`
- `PATCH /api/triggers/:id`
- `DELETE /api/triggers/:id`

## CLI convenience

Inside a normal RemoteLab session runtime, prefer the CLI wrapper instead of hand-written HTTP:

```bash
remotelab trigger create --in 2h --text "Follow up on this later" --json
```

The command:

- auto-auths through local owner credentials
- defaults to `REMOTELAB_SESSION_ID` for the target session
- defaults to `REMOTELAB_CHAT_BASE_URL` for the local control plane

Fallback when `remotelab` is not on `PATH`:

```bash
node "$REMOTELAB_PROJECT_ROOT/cli.js" trigger create --in 2h --text "Follow up on this later" --json
```

Minimal create payload:

```json
{
  "sessionId": "<session-id>",
  "scheduledAt": "2026-03-20T12:00:00.000Z",
  "text": "Wake this session with a short follow-up"
}
```

Optional runtime overrides:

```json
{
  "title": "Noon check-in",
  "tool": "fake-codex",
  "model": "fake-model",
  "effort": "low",
  "thinking": false
}
```

## Known limitation

`session_message` is correct for deferred AI work.
It is the wrong primitive for deterministic outbound delivery where the payload is already known.

Example of the wrong pattern:

- schedule "at 22:40 send this exact WeChat reminder"
- deliver it by waking a session
- wait for an assistant reply
- expect that reply to automatically flow back into WeChat

That pattern can produce visible RemoteLab activity without any connector-side delivery.

The correct V2 expansion is a second action type:

- `connector_action`

That future shape should carry:

- `connectorId`
- `actionId`
- `bindingId`
- `target`
- `payload`

and execute through the same connector activation path used by live tool calls.

## Explicit non-goals for v0

Not in scope yet:

- recurring schedules
- arbitrary condition graphs
- multi-step workflow DAGs
- trigger-created new sessions
- UI surface for trigger authoring
- model-native trigger tools / permissions

Those can come later, but only after this narrow wake-up primitive proves stable.

## Intended next expansions

If this v0 works well, the next steps should likely be:

1. session-scoped trigger listing in the UI
2. agent-facing trigger creation tools built on the same HTTP/control surface
3. `connector_action` action type for deterministic external delivery
4. `external_event` trigger type with the same delivery contract
5. stable links between trigger objects and control-inbox / reminder flows

The main rule should stay the same:

automation policy belongs to durable server-owned trigger objects,
while actual work execution flows either through the normal session/run grammar or through a first-class connector action path, depending on the action type.
