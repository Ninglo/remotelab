# Connector State Surface And Email Generalization Plan

Status: current working note as of 2026-04-06

Companions:

- `notes/current/instance-scoped-connectors.md`
- `docs/external-message-protocol.md`
- `docs/trigger-control-plane-v0.md`
- `docs/cloudflare-email-worker.md`
- `notes/local/agent-mailbox.md`

## Why this note exists

- RemoteLab's email path is the closest current implementation of a real external side-effect flow.
- It already has useful isolation pieces such as guest-instance mailbox roots and routed addresses.
- But the product and runtime contract are still too email-specific and too split across internal statuses to become the generic connector model for calendar, reminders, notifications, or Feishu.

## Product rule

Keep the product simple:

- one shared connector surface
- per-instance isolated bindings
- no product-facing fallback to host-local native apps
- no extra `owner` abstraction added back into the main model

If a flow breaks, we fix the flow.
We do not preserve correctness by silently using a more privileged or more local path than the user-facing product actually promises.

## Current implementation reality

Today the email stack is split across several narrower concepts:

- sessions can carry email-only `completionTargets`
- runs persist `completionTargets[targetId].state` as `sending`, `sent`, or `failed`
- mailbox queue items persist worker-specific states such as `processing_for_reply`, `reply_sent`, `reply_failed`, `submitted_to_session`, and `session_submission_failed`
- guest instances can isolate mailbox roots, auth files, and routed addresses
- triggers can wake sessions, but they do not yet resolve a generic connector binding/action state

That means the system can often answer:

> did this mailbox worker send a reply?

But it cannot yet answer in a clean generic way:

> can this instance perform this external action, through which binding, to which target, and what happened?

## Canonical objects

### Connector

Shared adapter family such as:

- `email`
- `calendar`
- `feishu`
- `notification`

### Binding

Instance-scoped authorized account or identity for one connector.

Examples:

- one instance's outbound email identity
- one instance's calendar OAuth grant
- one instance's Feishu bot/app identity

### Target

Binding-scoped destination for the side effect.

Examples:

- one email thread
- one mailbox address
- one calendar
- one Feishu chat

### Action

One concrete attempt to create an external side effect.

Examples:

- send an email reply
- create a calendar event
- send a Feishu message
- schedule a reminder delivery

## Status surface

Use two layers of status.

### 1. Capability state before execution

This answers whether the action is currently possible for this instance.

- `connector_unavailable`
- `binding_required`
- `authorization_required`
- `ready`

These states should be generic across connectors and should be visible to the model/tool layer.

### 2. Delivery state after execution starts

This answers what happened to one concrete action attempt.

- `drafted`
- `queued`
- `sending`
- `delivered`
- `delivery_failed`
- `cancelled`

These states should be generic across connectors and should be visible in run/session projections.

### Important rule

Do not overload internal worker states as product truth.

For example:

- mailbox queue states are mailbox-worker internals
- provider HTTP retries are transport internals
- Cloudflare or Resend specifics are provider internals

Those can map into the generic state surface, but they should not become the cross-connector product contract.

## Suggested action result shape

Any future connector tool or runtime path should be able to return a result shaped like:

```json
{
  "connectorId": "email",
  "bindingId": "instance_email_primary",
  "targetId": "thread:abc123",
  "capabilityState": "ready",
  "deliveryState": "delivered",
  "externalId": "<provider-or-thread-message-id>",
  "message": "Sent through the bound email connector.",
  "retryable": false,
  "requiresUserAction": null
}
```

When a binding is missing:

```json
{
  "connectorId": "email",
  "bindingId": "",
  "targetId": "thread:abc123",
  "capabilityState": "binding_required",
  "deliveryState": "drafted",
  "externalId": "",
  "message": "This instance does not have an email binding yet.",
  "retryable": false,
  "requiresUserAction": {
    "kind": "connect_binding"
  }
}
```

## How email should map into this model

Treat the current email system as the first connector implementation, not as the universal contract.

### Keep

- mailbox ingestion and review queues
- guest-instance mailbox isolation
- routed addresses and runtime selection
- provider-specific outbound delivery code

### Change

- stop treating `completionTargets` as the long-term generic abstraction
- treat `mailboxRoot`, `mailboxItemId`, and similar fields as email-internal binding resolution details, not universal session-facing concepts
- map mailbox worker states into generic capability/delivery states
- stop letting the session surface answer only in email-specific terms

## Migration direction

### Phase 1 — generic state contract

- introduce a small shared connector state module
- define generic capability and delivery enums
- define one normalized action-result shape

### Phase 2 — binding registry

- add an instance-local binding registry
- give every connector binding a stable `bindingId`
- resolve email identity through a binding id instead of implicit mailbox-root-only logic

### Phase 3 — email compatibility adapter

- keep existing email worker behavior
- wrap its results into the generic connector state surface
- keep `completionTargets` only as a compatibility shim until migration finishes

### Phase 4 — trigger and tool integration

- let triggers reference connector action/binding context explicitly
- let future connector tools return the same generic capability/delivery result shape

## Immediate next engineering tasks

1. Define the generic enums and result schema in code before adding more connector-specific features.
2. Add a binding registry that is instance-local rather than mailbox-root-specific.
3. Create an email adapter that maps current mailbox/completion-target states into the generic connector state surface.
4. Project the generic states into session/run APIs so the UI and prompt layer can say `binding_required` or `delivery_failed` without email-specific leakage.
5. Only after that, add new connector tools for calendar, reminders, notifications, or Feishu.

## Likely code starting points

- `lib/agent-mail-completion-targets.mjs`
- `lib/agent-mailbox.mjs`
- `lib/connector-state.mjs`
- `lib/connector-bindings.mjs`
- `scripts/agent-mail-worker.mjs`
- `chat/session-connectors.mjs`
- `chat/session-manager.mjs`
- `chat/router-session-main-routes.mjs`
- `chat/triggers.mjs`

The main goal is not to rewrite email first.
The main goal is to make email the first adapter behind a generic connector state contract.

## V0 landing (done)

The first implementation pass kept the current email transport behavior intact while changing the state surface:

- persist or synthesize an instance-local email binding with a stable `bindingId`
- keep email worker payloads backward-compatible, but attach `bindingId` whenever a reply target is created
- project generic `capabilityState` and `deliveryState` onto session/run API responses under a connector-facing surface
- continue storing email-specific worker states internally until trigger and tool paths migrate to the generic result contract

## V1 — generic dispatcher + calendar connector (done)

Multi-connector support landed via a generic action dispatcher and calendar as the second connector type:

### Generic action dispatcher (`lib/connector-action-dispatcher.mjs`)
- `sanitizeAllCompletionTargets()` handles both email and calendar targets in a single pass
- `dispatchSessionConnectorActions()` replaces direct calls to `dispatchSessionEmailCompletionTargets`
- Routes targets to the correct connector handler by type; email goes to existing email path, calendar goes through `connector-calendar.mjs`
- Session turn completion now uses the generic dispatcher, not the email-specific one

### Calendar connector binding (`lib/connector-bindings.mjs`)
- `ensureCalendarConnectorBinding()` / `resolveCalendarConnectorBinding()` parallel the email binding API
- Calendar bindings carry: `provider`, `accountHint`, `calendarId`, `tokenPath`
- Capability state lifecycle: `binding_required` → `authorization_required` (provider + account, no token) → `ready` (token present)
- Stable binding IDs: `binding_calendar_{sha256(provider:accountHint).slice(0,12)}`

### Calendar connector module (`lib/connector-calendar.mjs`)
- Full CRUD: `listCalendarEvents`, `createCalendarEvent`, `updateCalendarEvent`, `deleteCalendarEvent`
- OAuth auth flow helpers: `generateCalendarAuthUrl`, `handleCalendarAuthCallback`, `startCalendarAuthServer`
- Instance-scoped: reads credentials and tokens from binding-specified paths, not owner-local defaults
- Returns standard `createConnectorActionResult()` shapes for all operations

### Session/run connector surface
- `session-connectors.mjs` now builds connector surface from both email and calendar completion targets
- `session-manager.mjs` uses `sanitizeAllCompletionTargets` for session create/update, accepting mixed connector types
- `session-turn-completion.mjs` uses `dispatchSessionConnectorActions` as the single dispatch entry point

### Tests
- `test-connector-action-dispatcher.mjs`: sanitization, calendar binding lifecycle, mixed session surface projection, dispatcher routing
- All existing email tests pass unchanged: `test-session-connector-state-surface`, `test-agent-mail-reply`, `test-agent-mail-worker`

### Open items for V2
- Calendar completion targets are not yet dispatched through `updateRun()` state tracking (email does this, calendar only returns results)
- OAuth auth flow needs a chat-surface integration to push the auth URL to the remote user
- `completionTargets` field on sessions should eventually be deprecated in favor of a generic connector actions field
- Trigger integration: triggers should reference connector binding context explicitly
- Feishu / notification connectors: follow the same pattern as calendar
