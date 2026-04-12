# Connector V2 Architecture

Status: proposed hard-cut target for the next connector refactor

This document defines the canonical Connector architecture for the next RemoteLab pass.

It assumes a deliberate hard cut:

- no long-lived runtime compatibility branches
- no old/new connector shapes living side by side
- no manual per-connector model registration steps
- one coordinated rollout, then one coordinated restart

If this document conflicts with older connector notes or protocol drafts, this document governs new connector work after the cutover.

---

## 1. Why V2 exists

RemoteLab currently mixes several partially overlapping connector ideas:

- script-style instance-local connectors
- routing-aware gateway connectors
- connector skill registry code
- run-completion side-effect dispatch
- manual or implicit model capability exposure

These pieces are individually useful, but together they create ambiguity about:

- what a Connector actually is
- where Connector capability is declared
- how gateway and single-instance deployments relate
- how model-visible tools are derived
- which layer owns registration, routing, binding, and delivery state

V2 fixes that by defining one canonical model.

---

## 2. Core judgment

The architecture must separate:

- what a Connector is
- where it runs
- which instance is authorized to use it
- which concrete capabilities are active right now

Therefore V2 uses these first-class objects:

### 2.1 Connector Definition

The shared product and engineering definition of one connector family.

Examples:

- `email`
- `wechat`
- `feishu`
- `calendar`

The definition is the only source of truth for:

- connector identity
- action specs
- binding requirements
- inbound and reply capability declarations
- supported host strategies

### 2.2 Host Strategy

The execution topology for a connector.

Host strategy is not connector identity. It is how a connector is hosted.

V2 defines two built-in strategies:

- `local` — the connector runtime lives with one RemoteLab instance
- `gateway` — the connector runtime is a shared routing surface that serves many instances

A single Connector Definition may support one or both strategies.

Examples:

- `wechat` may support only `local`
- `email` may support both `local` and `gateway`
- `feishu` may support both `local` and `gateway`

### 2.3 Binding

An instance-scoped authorization and identity record for one connector.

A binding answers:

- which instance is acting
- which account or bot identity is authorized
- which scopes are granted
- which target defaults are available

Bindings are never host-global truth and never implied by ambient owner machine state.

### 2.4 Activation

The resolved runtime relationship between:

- one instance
- one connector definition
- one chosen host strategy
- zero or one active binding

An activation is the object the platform uses to decide:

- whether a connector is available
- which model-visible actions exist
- which runtime path to use for invocation
- what health and readiness state should be shown

### 2.5 Action Spec

The canonical declaration of a model-callable or system-callable capability.

Examples:

- `email:send`
- `wechat:send_text`
- `calendar:create_event`

Action specs are defined once in the Connector Definition and then projected into:

- model-visible tool catalogs
- system-side deferred actions
- docs
- tests
- runtime dispatch tables

### 2.6 Action Result

The normalized result shape returned by every connector action path.

At minimum it must include:

- `connectorId`
- `bindingId`
- `targetId`
- `capabilityState`
- `deliveryState`
- `externalId`
- `message`
- `retryable`
- `requiresUserAction`

Connector-specific transport details may be attached under a namespaced metadata field, but the cross-connector contract stays generic.

---

## 3. Non-negotiable V2 rules

1. Connector Definition is the only source of capability truth.
2. Gateway and single-instance are host strategies, not different connector species.
3. A connector may support both `local` and `gateway` strategies at the same time.
4. Bindings are instance-scoped, explicit, and never inferred from ambient host login state.
5. Model-visible tools are derived from active activations, not handwritten per connector.
6. Deferred side effects and interactive tool calls must share the same Action Spec contract.
7. Old script entry points may remain only as thin launchers, never as architecture truth.
8. No permanent runtime compatibility layer is kept after the cutover.

---

## 4. Package shape

Every connector must live under:

```text
connectors/<connector-id>/
  manifest.json
  index.mjs
  CONNECTOR.md
  tests/
```

Recommended optional structure:

```text
connectors/<connector-id>/
  manifest.json
  index.mjs
  CONNECTOR.md
  fixtures/
  tests/
  gateway/
  local/
```

Rules:

- `manifest.json` declares the contract
- `index.mjs` exports the runtime entrypoints
- `CONNECTOR.md` explains authoring and operational notes
- `tests/` validates both definition and runtime behavior

---

## 5. Manifest contract

Each connector ships one `manifest.json`.

Example:

```json
{
  "id": "email",
  "name": "Email",
  "version": "2.0.0",
  "description": "Inbound, reply, and send actions for email",
  "supports": {
    "inbound": true,
    "reply": true,
    "actions": true
  },
  "hostStrategies": [
    {
      "kind": "local",
      "default": false
    },
    {
      "kind": "gateway",
      "default": true
    }
  ],
  "bindingSchema": {
    "kind": "email_account",
    "required": ["identity", "provider"],
    "properties": {
      "identity": { "type": "string" },
      "provider": { "type": "string" },
      "scopes": { "type": "array", "items": { "type": "string" } }
    }
  },
  "actions": [
    {
      "id": "send",
      "title": "Send email",
      "description": "Send an email to one recipient",
      "toolName": "email:send",
      "targetKind": "recipient",
      "requiresBinding": true,
      "availability": "model",
      "inputSchema": {
        "type": "object",
        "required": ["to", "subject", "body"],
        "properties": {
          "to": { "type": "string" },
          "subject": { "type": "string" },
          "body": { "type": "string" }
        }
      }
    }
  ]
}
```

### 5.1 Required top-level fields

- `id`
- `name`
- `version`
- `supports`
- `hostStrategies`
- `bindingSchema`
- `actions`

### 5.2 Required action fields

- `id`
- `title`
- `description`
- `toolName`
- `targetKind`
- `requiresBinding`
- `availability`
- `inputSchema`

### 5.3 Tool naming

Tool names remain flat and explicit:

- `connectorId:actionId`

Examples:

- `email:send`
- `wechat:send_text`
- `calendar:create_event`

V2 keeps this format because it is readable, deterministic, and already aligned with current connector-skill thinking.

---

## 6. Runtime module contract

`index.mjs` exports the connector runtime entrypoints.

Required export:

```js
export const definition = manifestLikeObject
```

Optional strategy exports:

```js
export async function createLocalHost(context) {}
export async function createGatewayHost(context) {}
```

Each host implementation must return an object implementing the Host Contract for its strategy.

### 6.1 Host Contract

A host object may implement these methods:

- `health()`
- `resolveCapabilities(bindingContext)`
- `registerActivation(activationContext)`
- `teardownActivation(activationContext)`
- `invokeAction(callContext)`
- `deliverInbound(messageContext)`
- `sendReply(replyContext)`

Rules:

- `invokeAction()` is required when `supports.actions === true`
- `deliverInbound()` is required when `supports.inbound === true`
- `sendReply()` is required when `supports.reply === true`
- `registerActivation()` is required for `gateway` and optional for `local`
- `teardownActivation()` is required whenever registration creates remote or persistent runtime state

### 6.2 Strategy behavior

#### Local host

Typical behavior:

- no remote registration call
- activation is synthesized locally
- health is derived from local process state or local config
- action execution happens directly in instance-local code

#### Gateway host

Typical behavior:

- registration and heartbeat go to the gateway
- activation stores remote registration metadata
- inbound delivery is routed through gateway dispatch
- action invocation may forward through gateway RPC or endpoint calls

The platform must not care which strategy is selected after activation is resolved.

---

## 7. Activation model

An activation is the runtime-resolved connector surface for one instance.

Example shape:

```json
{
  "id": "activation_email_primary",
  "instanceId": "instance_a",
  "connectorId": "email",
  "hostStrategy": "gateway",
  "bindingId": "binding_email_primary",
  "capabilityState": "ready",
  "healthState": "healthy",
  "registration": {
    "registrationId": "reg_email_123"
  },
  "actions": [
    {
      "toolName": "email:send",
      "capabilityState": "ready"
    }
  ]
}
```

### 7.1 Capability state

Allowed generic states:

- `connector_unavailable`
- `binding_required`
- `authorization_required`
- `ready`

### 7.2 Health state

Allowed operational states:

- `healthy`
- `degraded`
- `stale`
- `offline`

Health is operational. Capability is user-facing readiness.
They must not be collapsed into one value.

---

## 8. Tool exposure model

Connector authors do not register model tools manually.

The platform derives model-visible tools from active activations:

1. load Connector Definitions
2. resolve supported host strategies
3. resolve bindings for the current instance
4. create activations
5. collect model-available action specs from activations
6. project them into the runtime-specific tool surface

Important rule:

Tool exposure is a platform adapter concern, not a connector authoring concern.

That means a connector author writes:

- action specs
- host implementations
- binding rules

But does not write:

- manual session prompt registration
- one-off tool wiring in system prompt text
- custom per-connector skill injection logic

### 8.1 Runtime adapters

V2 architecture allows multiple projection adapters:

- MCP adapter
- local wrapper adapter
- runtime-native tool adapter

These adapters are implementation detail. They all consume the same activation-derived action catalog.

---

## 9. Inbound, reply, and deferred actions

V2 treats these as one family, not three unrelated systems.

### 9.1 Inbound

Inbound delivery uses:

- connector definition
- chosen host strategy
- activation registration metadata
- normalized message contract

### 9.2 Reply

Reply publication uses the same activation that received or owns the thread.

Reply is not a separate connector species.
It is one host capability.

### 9.3 Deferred actions

Run-completion side effects must be expressed as planned connector actions that reuse the same Action Spec contract.

Do not preserve a separate permanent abstraction for connector-specific completion behavior if the same outcome can be expressed as:

- action id
- binding id
- target
- payload
- result

### 9.4 Scheduled connector actions

The trigger system must not stay session-message-only.

V2 distinguishes two deferred execution shapes:

- `session_message` — wake an existing session and re-enter the AI run pipeline
- `connector_action` — invoke one concrete connector action later through the resolved activation

They are not interchangeable.

Use `session_message` only when the future work genuinely requires model reasoning, drafting, classification, or conversation continuation.

Use `connector_action` when:

- the final outbound payload is already known
- the work is deterministic
- the main goal is delivery, not reasoning
- the outcome should happen even if no AI run is otherwise needed

Examples that should prefer `connector_action`:

- `wechat:send_text` reminder delivery
- `feishu:send_message` notification delivery
- `email:send` for pre-authored outbound mail
- webhook or simple push publication

Examples that may still use `session_message`:

- "check this thread again in 2 hours and decide whether to reply"
- "tomorrow morning draft a summary based on whatever changed overnight"
- "remind me later and include a fresh AI-written summary"

### 9.5 Deterministic delivery rule

If the message body is already known at scheduling time, the platform must not create a future AI wake-up just to restate that same body.

The scheduled object should instead carry:

- `connectorId`
- `actionId`
- `bindingId`
- `target`
- `payload`

and execute through the same activation-backed `invokeAction()` path used by live model tool calls.

This rule is especially important for messaging connectors.

For example, a WeChat reminder should schedule `wechat:send_text` directly rather than:

1. injecting a follow-up message into a RemoteLab session
2. waiting for a run
3. expecting the resulting assistant text to somehow be republished to WeChat

That older pattern is ambiguous, slower, and easy to mis-deliver.

### 9.6 Capability exposure rule

Prompt wording alone is not sufficient to make deterministic delivery reliable.

If a connector can publish a direct outbound action, that action must be visible as a first-class activation-derived capability.

The platform must not rely on:

- the model inferring a hidden direct-send path from connector internals
- one-off prompt prose that says "you can also send directly"
- connector-specific reminder hacks that bypass the common action registry

The correct system shape is:

- connector definition declares `wechat:send_text`
- activation exposes it as available
- scheduling and live tool calls both route through the same contract
- prompt policy tells the model when to prefer it

---

## 10. Platform responsibilities

The platform owns:

- definition discovery
- binding lookup
- activation lifecycle
- health polling and heartbeat scheduling
- model-visible action projection
- normalized result handling
- audit and run/session state projection

Connector packages own:

- definition content
- strategy implementations
- provider-specific request translation
- provider-specific error mapping

This keeps connector code small and keeps routing and tool exposure policy centralized.

---

## 11. What V2 explicitly removes

V2 removes these architectural patterns as first-class truth:

- script-style connectors that define their own registration semantics
- connector capability exposure by ad hoc prompt wiring
- host-ambient authorization as a default product path
- connector identity being conflated with deployment topology
- separate capability declaration systems for gateway and single-instance connectors
- permanent dual-path compatibility branches for old connector shapes

Thin launcher scripts may remain temporarily, but only as shell entrypoints that delegate into the canonical connector package.

---

## 12. Recommended rollout

Because V2 is a hard cut, rollout should be linear:

1. land V2 docs and contracts
2. implement platform activation manager
3. migrate `email` as the reference connector
4. migrate one gateway-oriented connector, likely `feishu` or `wechat`
5. migrate remaining connectors
6. remove old registration and script-only flows
7. restart all controlled services once on the new path

This is intentionally not a long compatibility migration.

---

## 13. Reference implementation order

### 13.1 First reference connector

`email`

Why:

- already closest to a declarative action model
- already has connector-sdk style structure
- easiest place to freeze Action Spec and Action Result contracts

### 13.2 First mixed-topology connector

`feishu`

Why:

- naturally supports gateway and local deployment stories
- useful for proving the host-strategy split cleanly

### 13.3 First local-only connector

`wechat`

Why:

- proves that instance-local private connectors still fit the same Definition and Activation model

---

## 14. What connector authors should read

After V2 lands, a new connector author should only need:

1. this document
2. the future `connector-authoring.md`
3. one reference connector package

If a connector requires extra manual registration steps outside this flow, that is a platform bug, not a connector authoring requirement.
