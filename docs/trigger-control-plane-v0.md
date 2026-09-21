# Trigger Control Plane v0

RemoteLab has a server-owned trigger control plane for deferred and recurring AI work.

This is intentionally small.
The goal is not to ship a general workflow engine or scheduler DSL.
The goal is to stop hiding automation policy inside prompts and standalone scripts when the platform needs a durable, inspectable, retryable wake-up primitive.

## Scope

The base trigger still has one action shape:

- trigger type: `at_time`
- action type: `session_message`
- target: either one explicitly fixed RemoteLab Session or a Session created from the stored template
- delivery: resolve or create that Session at fire time, then submit one canonical task message through the normal run path
- source Session: context/template seed; execution only reuses it when an explicit conversation binding resolves back to it

Recurring schedules materialize that same trigger shape from either a five-field cron expression or a seconds-based interval. An optional local script gate can decide whether a due check should materialize the Trigger at all. Both use `sessionTemplate.conversation`, the same optional binding accepted by normal Session creation. Task Center exposes cadence, lifetime, admission gate, execution target, result delivery, and alert policy as separate controls while continuing to use this one trigger/run path.

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
- `status` → `pending | paused | delivering | delivered | failed | cancelled`
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
- `sessionTemplate.reuse = fixed_session` plus `sessionTemplate.sessionId` — explicitly wake one existing Session instead of creating an execution Session

Task Center also uses `paused` as a reversible pre-admission Trigger state. The legacy CLI `cancel` operation continues to create the terminal `cancelled` state.

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

Recurring schedules are stored in `chat-recurring-schedules.json` and exposed through authenticated `/api/schedules` routes plus the `remotelab schedule` CLI. They support:

- five-field cron with IANA timezone, defaulting to `Asia/Shanghai`
- intervals down to 10 seconds
- `continuous` or bounded lifetime (`maxExecutions`, `maxChecks`, `endsAt`)
- direct admission or a snapshotted Bash/Python/Node yes/no script gate
- restart catch-up policy `latest_once`
- one open occurrence by default, so a slow Agent Run does not create a flood
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

Authenticated routes:

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
- `GET|POST /api/automation-tasks`
- `GET /api/automation-tasks/:id`
- `POST /api/automation-tasks/:id/pause|resume|cancel`

See [Task Center v1](task-center-v1.md) for the unified read model and stop semantics.

## CLI convenience

Inside a normal RemoteLab session runtime, prefer the CLI wrapper instead of hand-written HTTP:

```bash
remotelab trigger create --in 2h --text "Follow up on this later" --json
```

The command:

- auto-auths through the local service credential
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

High-frequency checks can avoid invoking an Agent until a cheap local condition matches:

```bash
remotelab schedule create \
  --every 30s \
  --times 5 \
  --gate-file ./check-change.sh \
  --gate-runtime bash \
  --cooldown 1m \
  --text "Inspect and report the matching state" \
  --json
```

The gate prints exactly `yes`, `no`, or strict JSON containing boolean `trigger`; failures are recorded and fail closed. Script gates run as the RemoteLab service user and are not a sandbox.

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

For long-running monitoring started from a connector conversation, use the
group-only target above so the monitor owns an independent Session and topic.
Use `--conversation source` or `--source-request` only when continuation in the
existing topic and its bound Session is intentional. Monitor cycles may remain
internal to the monitoring Session; they do not each need another topic.

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
- dedicated UI authoring and model-native permission controls

Those can come later, but only after this narrow wake-up primitive proves stable.

## Intended next expansions

Likely next steps:

1. agent-facing trigger creation tools built on the same HTTP/control surface
2. `connector_action` action type for deterministic external delivery
3. `external_event` trigger type with the same delivery contract
4. stable links between trigger objects and control-inbox / reminder flows

The main rule should stay the same:

automation policy belongs to durable server-owned trigger objects,
while actual work execution flows either through the normal session/run grammar or through a first-class connector action path, depending on the action type.
