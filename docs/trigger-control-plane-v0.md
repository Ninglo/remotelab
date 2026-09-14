# Trigger Control Plane v0

RemoteLab has a server-owned trigger control plane for deferred and recurring AI work.

This is intentionally small.
The goal is not to ship a general workflow engine or scheduler DSL.
The goal is to stop hiding automation policy inside prompts and standalone scripts when the platform needs a durable, inspectable, retryable wake-up primitive.

## Scope

The base trigger still has one execution shape:

- trigger type: `at_time`
- action type: `session_message`
- target: one RemoteLab Session selected by its creation template
- delivery: create or resolve that Session at fire time, then submit one canonical task message through the normal run path
- source Session: context/template seed; execution only reuses it when an explicit conversation binding resolves back to it

Recurring schedules materialize that same trigger shape from a five-field cron expression. Both use `sessionTemplate.conversation`, the same optional binding accepted by normal Session creation. There is no scheduled-result sender or separate binding policy.

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
- `sourceSessionId` — source/template session for context and list filtering
- `executionSessionId` — the Session created or resolved when the trigger fires
- `sessionTemplate` — source-derived template used to create the execution session
- `scheduledAt`
- `text`
- `tool`, `model`, `effort`, `thinking`
- `requestId`
- `createdAt`, `updatedAt`
- `deliveryAttempts`, `claimedAt`, `lastAttemptAt`, `nextAttemptAt`
- `deliveredAt`, `runId`, `deliveryMode`
- `lastError`, `lastErrorAt`
- `scheduleId`, `occurrenceId` when materialized by a recurring schedule
- `sessionTemplate.conversation` — optional external conversation; legacy `sourceDelivery` is normalized into this field when read

## Delivery semantics

The trigger scheduler runs inside `chat-server.mjs`.

For each due trigger:

1. claim it durably as `delivering`
2. create or resolve the execution Session from the stored template
3. submit the configured message to that execution session through `submitHttpMessage()`
4. reuse stable `requestId = trigger:<triggerId>` for idempotency
5. append a visible `status` event only in the execution session when delivery is newly accepted
6. mark the trigger as `delivered`

If delivery fails:

- transient failures retry with backoff
- permanent failures end as `failed`
- stale in-progress claims can be retried after timeout

Each trigger has a stable request ID and uses normal durable Session admission. If an explicitly bound Session is busy, the scheduled input waits as a separate request; it does not steer the active native turn. There is no parallel timer-only execution path.

## Recurring schedules

Recurring schedules are stored in `chat-recurring-schedules.json` and exposed through owner-only `/api/schedules` routes plus the `remotelab schedule` CLI. They support:

- five-field cron with IANA timezone, defaulting to `Asia/Shanghai`
- restart catch-up policy `latest_once`
- separate queued occurrences with a bounded open-occurrence backlog
- cancellation of future and pending occurrences; `--include-active` also requests cancellation of the active run

Each due occurrence becomes a normal durable Trigger with the same stored Session template:

- No `conversation`: a new ordinary Session per occurrence, with results in RemoteLab.
- Feishu group-only target: a new Session and a new group message/topic per occurrence.
- Existing topic target: resolve and continue that topic's bound Session.

The first result in a new external conversation carries its actual execution
Session link. Follow-ups continue that Session. A schedule's template stays
unchanged when one occurrence learns its newly published topic ID.

## Source delivery outbox

Deliveries live inside the durable Request aggregate under `requests/`. Normal Run finalization snapshots the bound destination and commits the reply with its outbox parts. The connector claims records for its `sourceRouteId`, sends and persists the external receipt, then acknowledges completion. The first Feishu receipt also establishes the new Session/topic binding. This is the same path as interactive replies.

Completed runs publish visible text and attachments; empty output stays silent. Failed or cancelled runs publish a short terminal notice. Formatting and native file sending remain connector responsibilities.

## HTTP API

Owner-only routes:

- `GET /api/triggers`
- `GET /api/triggers?sessionId=<id>`
- `POST /api/triggers`
- `GET /api/triggers/:id`
- `PATCH /api/triggers/:id`
- `DELETE /api/triggers/:id`
- `GET|POST /api/schedules`
- `GET|PATCH|DELETE /api/schedules/:id`
- `GET /api/source-deliveries`
- `POST /api/source-deliveries/claim`
- `POST /api/source-deliveries/:id/complete|fail`

## CLI convenience

Inside a normal RemoteLab session runtime, prefer the CLI wrapper instead of hand-written HTTP:

```bash
remotelab trigger create --in 2h --text "Follow up on this later" --json
```

The command:

- auto-auths through local owner credentials
- uses `REMOTELAB_SESSION_ID` only as the source for folder, runtime, system prompt, and optional connector return route
- creates a new execution Session by default; an explicit existing conversation binding can select its current Session
- defaults to `REMOTELAB_CHAT_BASE_URL` for the local control plane
- leaves output local by default; `--conversation source` explicitly inherits the source address
- accepts `--conversation '<JSON>'` or `--conversation-file <path>` for an explicit binding; `--source-request` and `--no-source-delivery` remain compatibility aliases

Fallback when `remotelab` is not on `PATH`:

```bash
node "$REMOTELAB_PROJECT_ROOT/cli.js" trigger create --in 2h --text "Follow up on this later" --json
```

Minimal create payload (the supplied session is a template source, not the execution target):

```json
{
  "sessionId": "<source-session-id>",
  "scheduledAt": "2026-03-20T12:00:00.000Z",
  "text": "Run a short follow-up in a new session"
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

Recurring example:

```bash
remotelab schedule create --cron "0 9 * * 1-5" --timezone Asia/Shanghai --text "Prepare the weekday brief" --json
```

## Optional conversation configuration

Use this JSON with `--conversation-file` on either `trigger create` or `schedule create`:

```json
{
  "connector": "feishu",
  "sourceRouteId": "bot-2",
  "target": { "chatId": "oc_example" }
}
```

This creates a new topic per execution. To continue an existing topic, use its
actual root message ID in `target.rootId` and `target.messageId`, and set
`target.replyInThread` to `true`. There is no extra new/reuse switch: the address
defines the behavior. HTTP callers may supply `conversation` at creation or
inside `sessionTemplate`; schedule PATCH accepts `conversation` (including
`null`). Existing stored `sourceDelivery` configurations are read into the same
template without changing their destination or re-sending past results.

## Known limitations

`session_message` in a new execution session is correct for deferred AI work.
It is the wrong primitive for deterministic outbound delivery where the payload is already known.

Example of the wrong pattern:

- schedule "at 22:40 send this exact WeChat reminder"
- deliver it by waking a session
- wait for an assistant reply
- expect that reply to automatically flow back into WeChat

That deterministic-reminder pattern still spends a model run and is not the preferred mechanism. Source delivery is intended for fresh AI-generated results.

Deterministic outbound delivery should still use a future second action type:

- `connector_action`

That future shape should carry:

- `connectorId`
- `actionId`
- `bindingId`
- `target`
- `payload`

and execute through the same connector activation path used by live tool calls.

## Explicit non-goals

Not in scope yet:

- arbitrary condition graphs
- multi-step workflow DAGs
- UI surface for trigger authoring
- dedicated UI authoring and model-native permission controls

Those can come later, but only after this narrow wake-up primitive proves stable.

## Intended next expansions

Likely next steps:

1. session-scoped trigger listing in the UI
2. agent-facing trigger creation tools built on the same HTTP/control surface
3. `connector_action` action type for deterministic external delivery
4. `external_event` trigger type with the same delivery contract
5. stable links between trigger objects and control-inbox / reminder flows

The main rule should stay the same:

automation policy belongs to durable server-owned trigger objects,
while actual work execution flows either through the normal session/run grammar or through a first-class connector action path, depending on the action type.
