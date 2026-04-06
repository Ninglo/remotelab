# Instance-Scoped Connectors And Account Bindings

Status: current working product note as of 2026-04-06

Companions:

- `notes/current/knowledge-layers-and-connectors.md`
- `notes/current/connector-state-surface.md`
- `docs/shared-tools.md`
- `docs/external-message-protocol.md`
- `docs/trigger-control-plane-v0.md`
- `notes/feishu-bot-connector.md`

## Why this note exists

- Recent product discussion exposed a mismatch between what RemoteLab can technically execute and what actually becomes true for the end user.
- The system can already create reminders, send notifications, or post outbound messages, but those actions may still resolve through the host owner's local accounts or host-local app state.
- That is acceptable for operator-only automation, but it is the wrong product truth for user-facing multi-instance workflows.

## Core judgment

RemoteLab should treat the host machine as an execution substrate, not as the user's personal app container.

For user-facing actions such as calendar writes, reminders, notifications, email sends, or Feishu messages:

- the shared part is the connector/tooling layer
- the isolated part is the instance's bound account, scopes, and delivery identity
- a side effect is only "real for the user" when it lands through that instance's own binding

So the product question is not only:

> can this machine perform the action?

It is:

> can this instance perform the action through its own bound account and delivery identity?

## Current mismatch to resolve

Several current pieces are individually reasonable but still lean owner-local:

- RemoteLab's shipped architecture is still framed as single-owner first, not as a generalized multi-user account system.
- Trigger v0 explicitly auto-auths through local owner credentials.
- Run finalization may dispatch completion-target side effects such as email replies.
- Guest instances already isolate config roots and can provision isolated mailbox addresses, but the broader product wording still risks implying that any successful host-side action automatically means "the user's thing happened."

This produces the bad product experience:

- the assistant says it can add a schedule or send a notification
- the host technically does something
- but the effect lands in the operator's own calendar, mail, or Feishu context
- so the user's real world did not change in the way the UI implied

## Product truth

### 1. Shared connectors, isolated bindings

RemoteLab should have one shared connector surface for capabilities such as:

- calendar
- reminders
- email
- IM / Feishu
- docs
- browser-driven SaaS flows

But every concrete instance should keep its own:

- connected account identity
- access and refresh tokens or other credentials
- approved scopes
- channel bindings
- delivery defaults
- revocation state

The capability is shared.
The authority to act is instance-scoped.

### 2. Side effects must declare their execution identity

Every external write should resolve through an explicit binding, not vague host ambient state.

Minimum questions every side effect should answer:

- which instance is acting?
- which connector is being used?
- which binding/account is authorized?
- what delivery target or channel should receive the result?

If those answers are missing, the action should stop at a clear `needs_binding` or `needs_authorization` state instead of silently falling back to the host owner's local app state.

### 3. Host-local app integrations are operator tools, not default product surfaces

Using Apple Calendar, Mail.app, or host-local login state may remain useful as an owner-side convenience path.

But that path should be framed as:

- operator-local automation
- debugging convenience
- temporary bootstrap for the machine owner

It should not be the default semantics for end-user-facing product promises.

### 4. "Can do" and "will affect your world" are separate states

RemoteLab should distinguish:

- connector available
- instance binding connected
- permission scope granted
- action executed
- delivery confirmed

This avoids overstating capability when the system only has host-level power, not user-level authority.

## Recommended terminology

### Connector

The reusable adapter/runtime for a platform.

Examples:

- Google Calendar connector
- Feishu connector
- email connector

Connectors are shared implementation surfaces.

### Account binding

The instance-local authorization and identity record for one connector.

Examples:

- this instance's Google Calendar OAuth grant
- this instance's Feishu app or bot identity
- this instance's outbound email identity

Bindings are isolated by instance.

### Delivery target

A concrete outbound destination under a binding.

Examples:

- a specific Feishu chat
- a specific email thread
- a specific calendar

### Host-local integration

Any action that depends on the operator machine's ambient app/login state instead of an instance-owned binding.

This should be treated as a non-default compatibility path.

## Isolation model

The clean near-term shape is:

1. shared connector code and tool wrappers live once on the machine
2. each instance keeps its own binding overlay and secrets
3. sessions and triggers reference bindings by stable ids
4. execution resolves through the target session's instance context
5. delivery/audit records store which binding actually performed the write

That matches the existing product direction:

- shared connectors remain common infrastructure
- per-instance secrets and account bindings stay local to that instance
- authorization and side effects stay separate from memory and knowledge layers

## Trigger and follow-up rule

Scheduled work should inherit the target session's instance binding context.

So a future reminder or follow-up should mean:

- wake the session later
- resolve the same instance-scoped connector binding
- perform the write through that binding

It should not mean:

- wake later
- auto-auth through owner-local credentials
- write into whichever host account happens to be available

## User-facing wording guidance

Default wording should make the binding boundary obvious.

Good product wording:

- "Connect your calendar for this workspace."
- "This workspace does not have a calendar connected yet."
- "I can draft the reminder now and send it after you connect Feishu."
- "This event was created in the calendar connected to this workspace."

Bad product wording when no binding exists:

- "I already added it to your calendar."
- "I sent it on Feishu."

Those are only true after a bound connector actually executes the write.

## Minimum connector tool capability surface

If RemoteLab adds first-class connector tools, the tool contract should expose at least:

- connector identity: which platform or adapter is being invoked
- binding identity: which instance-scoped account binding is acting
- delivery target identity: which calendar, thread, chat, mailbox, or channel should receive the side effect
- readiness state: `connector_unavailable`, `binding_required`, `authorization_required`, `ready`, `delivery_failed`
- required scopes: what permission is missing when the action cannot run yet
- draft-first behavior: the system should still be able to draft the intended reminder/message/event without falsely claiming delivery
- explicit result metadata: whether the action was executed, where it landed, and any external id or delivery receipt

The tool prompt/description should also make three things explicit:

- prefer connector/API-based writes over ambient host app state
- missing binding is a real blocker, not a reason to silently fall back to owner-local apps
- if owner-local compatibility tools exist, keep them as separate explicit tools rather than the default path for generic user-facing actions

## Suggested implementation phases

### Phase 0 — clarify semantics before adding more integrations

- mark current owner-local flows as operator-local compatibility paths
- stop describing host-local side effects as generic user outcomes
- prefer `connector`, `binding`, and `delivery target` over vague "it can send" wording

### Phase 1 — add instance-scoped binding records

- introduce a binding registry keyed by instance
- keep secrets/tokens in instance-local config roots or overlays
- let connectors resolve bindings through explicit ids instead of ambient host state

### Phase 2 — make triggers and side effects binding-aware

- attach binding references to sessions, triggers, and outbound actions
- require explicit binding resolution before any external write
- persist audit metadata about which binding performed the action

### Phase 3 — remove host-local defaults from end-user flows

- treat Apple Calendar / Mail.app / other ambient host apps as owner-only tools
- keep them out of normal product promises for guest or user-scoped instances

## Non-goals for this note

This note does not try to lock down:

- the exact OAuth UI
- token storage encryption details
- whether a connector uses OAuth, bot credentials, service accounts, or API keys
- a full hosted multi-tenant account system

The point here is to freeze the product truth and isolation rule before more implementation accumulates on the wrong semantics.
