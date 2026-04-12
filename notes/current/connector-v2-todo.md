# Connector V2 TODO

> Status: active execution checklist as of 2026-04-11
> Use this note as the coordination board for the current connector / trigger / direct-delivery refactor.
>
> Companion docs:
>
> - `docs/connector-v2-architecture.md`
> - `docs/trigger-control-plane-v0.md`
> - `notes/current/wechat-connector-followups.md`
> - `notes/current/instance-scoped-connectors.md`
> - `notes/current/connector-state-surface.md`
> - `notes/current/connector-reply-publication-architecture.md`

This note is intentionally execution-oriented.
It does not reopen the main architecture debate.
It records what has already been decided and breaks the work into slices that can be implemented without losing the plot.

---

## Why this note exists

The current connector work has spread across:

- connector registration and skill exposure
- local vs gateway deployment
- instance binding and activation state
- WeChat reminder delivery
- trigger semantics
- reply publication
- connector runtime lifecycle

These topics are related, but they should not keep getting mixed in one ad hoc implementation pass.

This note exists to:

- keep the agreed contract visible
- prevent overlapping refactors from colliding
- make it obvious what to do next
- reduce the chance of fixing one connector while forgetting the shared platform gap

---

## Frozen decisions

These points are already decided unless explicitly reopened.

### 1. Hard cut, not long-lived compatibility

- no permanent dual-path runtime compatibility
- no old/new connector shapes living side by side as first-class architecture
- one coordinated migration pass
- one coordinated restart after the new path lands

### 2. Connector Definition is the only capability source of truth

- connectors declare actions once
- platform derives model-visible tools from activations
- connector authors should not manually register per-connector skills in prompts or runtime glue

### 3. Local and gateway are host strategies, not different connector species

- one connector may support `local`
- one connector may support `gateway`
- one connector may support both
- shared capability definition stays the same across those strategies

### 4. Bindings are instance-scoped

- bindings represent explicit account / bot / scope authorization
- bindings are not ambient machine state
- connector actions with external side effects must resolve through bindings

### 5. Deterministic delivery must not wake AI just to restate text

- deferred AI work uses `session_message`
- deterministic external delivery uses `connector_action`
- a WeChat reminder with known text should schedule `wechat:send_text` directly
- reminders and notifications should not require a new model run unless reasoning is actually needed

### 6. Script-style connectors are not architecture truth

- old scripts may remain as thin launchers temporarily
- the canonical shape is connector package + manifest + runtime contract

---

## Confirmed current code gaps

These are not open questions; they are the current baseline problems.

- trigger delivery is still hard-coded to `session_message`
- trigger execution still routes through session submission rather than connector invocation
- WeChat direct send exists at the transport layer but is not exposed as a first-class activation-derived action
- connector skill registry / capability exposure is not yet the single clean path used by all connectors
- current system guidance has historically over-taught trigger wake-ups and under-exposed direct connector delivery

---

## Success criteria

The connector V2 pass is only done when all of these are true:

- a connector can declare actions once and have them exposed consistently
- the same action contract works for immediate invocation and deferred invocation
- a fixed-text reminder can reach WeChat without creating a new AI run
- local and gateway host strategies share one activation and dispatch model
- new connectors do not need a human to remember extra skill-registration steps

---

## Execution order

Do these in order unless a later slice is tiny and blocked only on documentation.

### `C0` — Keep the contract frozen and visible

- `[x]` Write `docs/connector-v2-architecture.md`
- `[x]` Write the trigger/direct-delivery rule into docs
- `[x]` Update prompt guidance so deterministic notifications prefer direct connector actions when available
- `[ ]` Summarize the shipped contract in `docs/project-architecture.md` after runtime behavior lands

Guardrail:

- do not reopen connector identity vs host strategy unless the runtime implementation proves the contract impossible

### `C1` — Add trigger support for deferred connector actions

Goal:

- extend the trigger control plane so a trigger can invoke a connector action directly instead of only injecting a session message

Main work:

- add `connector_action` as a supported trigger action type
- define stored fields for `connectorId`, `actionId`, `bindingId`, `target`, and `payload`
- update HTTP create/list/get/patch/delete behavior as needed
- update CLI shape if create payload needs action-target arguments
- record normalized delivery result for connector-triggered actions

Acceptance:

- one trigger can deliver a direct connector action without generating a user message in the session

### `C2` — Land a canonical connector action dispatch path

Goal:

- immediate and deferred connector actions must share one invocation contract

Main work:

- choose or finish the activation-backed dispatch helper
- route invocation through connector definition + host strategy + binding + activation
- keep local and gateway dispatch behind one host contract
- normalize result mapping into one Action Result shape

Acceptance:

- the same logical action can be called from live model tooling and from trigger delivery without forked connector-specific code

### `C3` — Make WeChat `send_text` the first real behavior change

Goal:

- use WeChat reminder delivery as the first end-to-end proof that V2 works

Main work:

- expose `wechat:send_text` as a first-class connector action
- define target semantics for the bound WeChat thread / session
- route reminder delivery through connector action dispatch, not session wake-up
- keep any old script entry only as a thin launcher if still needed

Acceptance:

- a scheduled WeChat reminder reaches WeChat directly
- RemoteLab may record delivery state, but no assistant run is required for the send itself

### `C4` — Unify model-visible capability exposure

Goal:

- connector actions should become available to the runtime through one derived catalog

Main work:

- finish activation-derived tool exposure
- remove manual one-off skill wiring for connector actions
- ensure direct-send connector actions are visible enough that the model chooses them

Acceptance:

- adding a new connector action does not require hidden prompt surgery or ad hoc runtime glue

### `C5` — Migrate reference connectors in a controlled order

Order:

1. `email`
2. `feishu`
3. `wechat`

Notes:

- `email` is the easiest contract reference
- `feishu` is the best mixed-topology proof
- `wechat` is the first high-value deterministic delivery proof

Acceptance:

- all three connectors use the same package/runtime contract even if their host strategies differ

### `C6` — Fold reply publication and deferred delivery into the same mental model

Goal:

- stop treating reply publication, direct connector sends, and deferred delivery as unrelated bugs

Main work:

- keep reply publication on its own helper path where needed
- ensure the object model still lines up with connector definition / activation / action result
- keep documentation clear about which problems are reply-finalization problems vs direct-delivery problems

Acceptance:

- future debugging can distinguish publication bugs from trigger-delivery bugs quickly

### `C7` — Remove obsolete paths after the cutover

Main work:

- remove manual connector-skill registration steps that no longer matter
- remove connector-specific reminder hacks
- remove old trigger assumptions that only `session_message` exists
- trim docs that still imply deterministic notifications should go through AI sessions

Acceptance:

- the remaining codebase tells one story

---

## Session slicing rules

Use these to keep implementation sessions narrow.

### Good single-session slices

- `C1` trigger object + storage + API only
- `C2` dispatch helper + result mapping only
- `C3` WeChat direct-send migration only
- `C4` capability exposure only
- docs/tests tightening for one completed slice only

### Avoid combining in one session

- trigger storage changes + big connector migration + UI work
- host-strategy refactor + reply publication cleanup + WeChat runtime lifecycle changes
- naming sweep + behavioral refactor + persistence migration

### Test rule

Each slice should land with the most local tests possible:

- trigger tests for trigger semantics
- connector tests for action dispatch
- runtime/tool exposure tests for model-visible capability behavior
- WeChat regression tests for reminder delivery

---

## Immediate next slices

If starting from the current repository state, the best next implementation sequence is:

1. `C1` trigger `connector_action` shape
2. `C2` shared connector action dispatch helper
3. `C3` WeChat `send_text` reminder path
4. `C4` activation-derived tool exposure cleanup
5. `C5` connector migrations and old-path removal

---

## Explicit non-goals for this pass

- generic workflow engine design
- recurring schedule DSL
- perfect UI for trigger authoring before the backend contract exists
- preserving old connector behavior through long-term compatibility scaffolding

---

## Done-for-now check

Before closing this refactor, confirm:

- `[ ]` fixed-text reminders no longer wake AI just to send text
- `[ ]` WeChat direct reminder path works end to end
- `[ ]` at least one mixed-topology connector proves the host-strategy model
- `[ ]` docs explain connector action vs session wake-up clearly
- `[ ]` old prompt/runtime wording that teaches the wrong path is removed
