# WeChat Connector Follow-ups

Status: active execution todo as of 2026-04-11

Companions:

- `notes/current/connector-v2-todo.md`
- `notes/current/user-feedback-log.md`
- `notes/current/connector-reply-publication-architecture.md`
- `notes/current/connector-state-surface.md`
- `docs/connector-plugin-protocol.md`

Primary coordination note:

- use `notes/current/connector-v2-todo.md` for shared platform sequencing
- keep this note focused on WeChat-specific follow-ups and stopgaps

## Why this note exists

- A user-facing WeChat reminder appeared inside the RemoteLab session but did not reach WeChat.
- A later WeChat message received neither the fast "processing" acknowledgement nor normal ingestion into RemoteLab because the owner poller had died.
- The debugging session exposed a deeper product question: if connectors are supposed to stay thin, why did adding a direct-send path require connector-local code instead of a main-instance-owned delivery primitive?

## Confirmed current state

- The current trigger control plane still delivers only `session_message`; it injects text into a session and stops there.
- WeChat direct send exists at the connector transport layer, and this machine now has a callable direct-send CLI entry plus a local owner-poller watchdog.
- The new direct-send and watchdog pieces are working stopgaps for this machine, not the final product architecture.
- The owner WeChat poller lifecycle is still partly managed by machine-local workspace scripts rather than a fully repo-owned runtime contract.

## Priority backlog

### P0 — move reminder / push delivery out of session injection

- Problem:
  Session triggers are the wrong abstraction for source-channel reminders. A reminder can appear in RemoteLab while never reaching WeChat because trigger delivery today means "submit a session message", not "deliver to the source channel".
- Desired outcome:
  RemoteLab has a first-class source-channel delivery primitive that can send a text payload to the bound connector target without requiring a model turn.
- Likely shape:
  Add a trigger/delivery action such as `source_channel_message` or `connector_message` owned by the main instance, not a connector-local workaround.
- Main files:
  `chat/triggers.mjs`
  `chat/session-manager.mjs`
  `chat/router-connector-routes.mjs`
  `docs/connector-plugin-protocol.md`
- Acceptance:
  A scheduled reminder bound to a WeChat session reaches WeChat even when no new assistant turn is created in the session transcript.

### P0 — define the thin-connector boundary more honestly

- Problem:
  The current system implicitly pushes delivery strategy into connector-local code because the main instance lacks a first-class "send to this source channel" contract.
- Desired outcome:
  The main instance owns delivery policy and scheduling, while connectors own transport/auth/session binding details only.
- Questions to settle:
  Should the main instance call connectors through a generic delivery API?
  Should source-bound sessions expose a canonical outbound target object?
  How should non-chat deliveries such as reminders, alerts, and digests share that contract?
- Acceptance:
  Adding a new outbound policy does not require the agent to invent connector-specific shell flows or add more connector-local orchestration logic.

### P0 — promote owner WeChat poller lifecycle into repo-owned runtime management

- Problem:
  The owner poller was recoverable only after local debugging because its startup and recovery path lived in machine-local workspace scripts and a transient service setup.
- Current stopgap on this machine:
  direct-send CLI is available in `scripts/wechat-connector.mjs`
  owner poller restart policy is `Restart=always`
  a local timer checks and repairs the poller every minute
- Desired outcome:
  The owner connector startup, restart, and health-check path should be installed from repo-owned code/templates rather than ad hoc local scripts.
- Main files:
  install/setup flow
  systemd templates
  owner connector bootstrap/login path
- Acceptance:
  A fresh owner instance gets the same durable WeChat poller behavior without local one-off scripts.

### P1 — unify connector health checks and self-recovery

- Problem:
  Connector liveness is still connector-specific and too easy to lose silently.
- Desired outcome:
  Connector health checks become a standard runtime capability with per-connector probes and recovery hooks.
- Main files:
  instance health / validation surfaces
  connector lifecycle helpers
  systemd/runtime setup
- Acceptance:
  RemoteLab can report "WeChat connector unhealthy" before the user discovers it by missing messages.

### P1 — add regression coverage for direct source-channel delivery

- Missing tests:
  direct WeChat send by session id bypasses session injection
  source-bound reminder path reaches WeChat directly
  inbound WeChat message gets a processing acknowledgement quickly after poller recovery
  owner poller survives or recovers from `SIGTERM` / `SIGKILL`
  launcher readiness does not false-positive on stale logs
- Acceptance:
  The next regression cannot silently reintroduce "RemoteLab saw it but WeChat did not" without tripping CI or live smoke checks.

### P1 — clean up architecture notes so they match the real code

- Problem:
  Current notes can blur together several separate issues:
  reply-publication finalization
  source-channel direct delivery
  poller runtime durability
- Desired outcome:
  Documentation distinguishes these as separate boundaries instead of one fuzzy "connector bug" bucket.
- Acceptance:
  Future debugging lands in the right subsystem quickly: publication, direct delivery, or runtime liveness.

## Immediate operating rule until the backlog lands

- Do not use `session_message` triggers for WeChat reminders or other source-channel pushes.
- For this machine, use the direct-send path for WeChat outbound messages and treat the current watchdog as a stopgap, not as final architecture.
