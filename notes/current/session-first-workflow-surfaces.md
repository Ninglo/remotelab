# Session-First Workflow Surfaces

> Status: current baseline.
> Purpose: freeze the organization model for session list / grouping / task-like workflow views so RemoteLab does not drift into parallel domain objects before they are truly needed.

---

## Core Decision

For the current RemoteLab architecture:

> `Session` is the only durable work object.

Everything the owner sees in workflow organization should be one of two things:

- canonical metadata attached to a session
- a derived UI projection over sessions

That means the current system does **not** have separate canonical objects for:

- `Task`
- `ProgressItem`
- `Group`

Those are product surfaces, not independent storage authorities.

## Current Product-Shape Rule

For the current discovery phase:

- Do not let any secondary workflow view define the main product shape while the owner interaction is still being discovered.
- Keep the active owner flow centered on the session list instead of preserving half-used planning surfaces.
- If a richer workflow view returns later, it should return as a derived projection over sessions, not as the object that justifies the workflow model.

This means retired planning surfaces were not something to refine in place during this phase. They were something to delete so the next interaction model could be designed more honestly from the session-first core.

---

## Workflow Surface Consequence

For the next product iteration:

- do not preserve retired workflow surfaces just to avoid losing familiar UI vocabulary
- do not let card/column vocabulary steer the main interaction model
- do not treat retired workflow surfaces as the central product risk during this rewrite
- do use the session-first foundation to design the owner flow again from first principles

---

## What Belongs On The Session Today

The current session-first workflow model is intentionally lightweight.

Durable session metadata may include fields such as:

- `name`
- `group`
- `description`
- `workflowState`
- `workflowPriority`
- `lastReviewedAt`
- `pinned`
- app/source association fields when relevant

Live execution state is still separate and should remain separate:

- active run lifecycle
- queued follow-ups
- rename / compaction activity

Any workflow projection should read those session-level signals. It should not invent a second durable “task status” object.

---

## What Workflow Projection Is

The remaining workflow projection is a projection over sessions.

In practical terms:

- session ordering is derived from live session activity, `workflowState`, `workflowPriority`, pinning, and recency
- attention cues are derived from `workflowState`, `workflowPriority`, and review timestamps
- any future secondary workflow view must still point back to the underlying session
- the session list and any future workflow view are projections over the same canonical objects
- a goal-oriented group summary/detail surface is acceptable as a derived projection over grouped sessions, as long as `group` stays a facet and the projection does not become hidden durable truth

So the correct mental model is:

```text
Session list = session compact view
Any future workflow view = session workflow projection
```

Not:

```text
A workflow view = separate task system that happens to link to sessions
```

---

## How To Think About `group`

`group` is currently a lightweight session metadata field.

It is useful for:

- visual grouping in the sidebar
- lightweight project/domain clustering
- helping the model generate a stable label for related work

It is **not** currently:

- a first-class parent entity
- a permissions boundary
- a durable container with its own lifecycle
- a place where independent workflow-surface logic should live

So the right current reading is:

```text
group = a session facet, not a new object
```

In a shared instance with account-tagged sessions, that facet is account-local:

```text
visible project identity = account + space + group
sidebar order = relative order inside one account scope
```

Two people may use different Space and Project taxonomies for similar work. Sidebar rendering, session-label catalogs, manual Sort List, and autonomous Project maintenance must filter to one account before deriving spaces, groups, counts, or ordering. An administrator's all-account view is an observation surface, never a valid scope for a cross-account rebalance.

## Projects List Grouping Strategy

The owner-facing Projects list should optimize for work recovery, not taxonomy purity.

A Project group is the entry the owner would reasonably open next time to resume a related workstream. It should be:

- broader than a single implementation step or one chat turn
- narrower than a whole company, repo, or product area when that bucket would mix unrelated decisions
- stable enough to collect repeated sessions over time
- small enough that the sessions inside share user intent, context, files, decisions, or next actions

The failure mode to avoid is one session becoming one Project. In the current owner Chat UI sample on 2026-06-12, 20 active Chat UI sessions produced 17 groups, with 16 singleton groups. The current target budget for that density is roughly 6 Projects. That is a clear over-splitting signal, even though some individual labels are semantically accurate.

Singleton Projects are acceptable only when the workstream is genuinely standalone, newly emerging but likely to recur, currently high-priority, or unrelated to every existing group. Otherwise, a narrow one-off session should be merged into the closest active Project group, with the session title and description carrying the specific subtask.

Grouping should be allowed to rebalance previous choices. A per-session label generated at creation time is provisional because it sees incomplete global context. The session-list organizer is the canonical cleanup pass for the current sidebar: it receives the scoped active-session snapshot and may rewrite `group` and `sidebarOrder` across every session in that scope. It should not behave as append-only classification for one new row.

This also means Project compression is allowed without introducing a Project object. If several older groups become fragments of one better workstream topic, the organizer can choose a clearer shared Project name and patch every included session to that `group`. The durable data remains session metadata; the compression is a scoped maintenance pass over those sessions.

Rebalancing should use the whole scoped snapshot:

- title, description, current group, workflow state, priority, source, folder, and recency
- the current group count versus the target budget
- singleton ratio and obvious near-duplicate groups
- source scope, so Chat UI sorting does not get polluted by Feishu/Bot/Automation audit sessions unless that source filter was explicitly selected
- exactly one account scope, so one person's taxonomy and ordering never rewrite or train against another person's sessions

If the metadata is insufficient for an important merge/split decision, the organizer may inspect a small number of ambiguous session details. It should not do broad archaeology before every sort; the normal path is global metadata first, targeted detail reads only for high-impact ambiguity.

Default granularity rules:

- Merge sessions when they are slices of the same user-facing workstream, even if their immediate titles mention different features.
- Split sessions when they have different outcomes, lifecycles, owners, source/audit behavior, or would make the group harder to resume.
- Keep high-priority active work separate when merging would hide the next action.
- Prefer a readable sidebar over a perfectly semantic hierarchy, because RemoteLab currently has only one visible Projects level.

Sorting should serve return-to-work. Running groups should rise first, groups needing owner attention should rise next, and then organized groups should follow the lowest `sidebarOrder` among their sessions. Latest activity remains the fallback for unorganized or newly created groups, so fresh work can still surface before the next Sort List rebalance. A true group-level pin/order object is only needed later if Projects become first-class objects.

### Drift-Triggered Sort List

Do not run a full Sort List rebalance after every new session. That would make the sidebar feel unstable and would spend model work on noise.

Use three levels instead:

1. **Local repair** during single-session labeling.
   - Prefer a plausible existing workstream group for the new session.
   - Let the title and description carry subtask specificity.
   - Do not rewrite older sessions from this path.

2. **Sort recommended** when deterministic health metrics show drift.
   - This can update the button, badge, or subtle status text.
   - It should be driven by cheap `groupSummary` metrics, not by an LLM deciding to invoke itself.
   - Good first thresholds: at least 8 scoped sessions, actual group count above `targetProjectCount * 1.5`, at least 4 singleton groups, or singleton ratio at or above 0.45.

3. **Autonomous Sort List** only for severe drift and with cooldowns.
   - Scope must be explicit, usually Chat UI.
   - No organizer run already in flight.
   - Do not run more than once per source scope per day by default.
   - Require a severe signal such as group count above `targetProjectCount * 2`, at least 6 singleton groups, or singleton ratio at or above 0.6.
   - Run only after the current user-facing turn reaches a terminal state, not while the user is typing or while many foreground sessions are running.
   - The run may patch only `group` and `sidebarOrder` on scoped non-archived sessions.

The important separation is:

```text
deterministic drift detector decides whether sorting is warranted
AI organizer decides how to merge, rename, split, and order once invoked
```

This keeps the self-healing loop strict enough to avoid constant churn while still allowing the Projects list to recover when fragmentation becomes obvious.

---

## How To Think About `task`

People can absolutely talk about “tasks” in product language.

But under the current architecture, a “task” should usually collapse into one of these:

- the session itself when the work is one durable thread
- the session title / description when the work only needs labeling
- `workflowState` / `workflowPriority` when the work only needs lightweight workflow organization
- future cross-session structure only when one real unit of work outgrows a single session

So unless something has its own identity and lifecycle independent from a session, do **not** persist it as a separate task object.

---

## Architectural Rules

When adding workflow-management features, prefer these rules in order:

1. Attach durable presentation/workflow metadata to `Session` first.
2. Derive list/filter/secondary workflow views from sessions second.
3. Only introduce a new object if session metadata can no longer express the product honestly.

Three hard constraints should hold:

1. A workflow view must not own truth that the session does not.
2. The frontend must not silently invent a second authoritative workflow model.
3. The backend must not maintain a separate task-style store unless the product intentionally grows a new canonical object.

---

## When A Second Layer Becomes Legitimate

It is reasonable that RemoteLab may eventually need something above sessions.

But that should happen only when the product has a real need for a cross-session work object, for example when one unit of work needs:

- multiple sessions over time
- a stable identity independent from any single session
- its own summary / status / archival semantics
- cross-session notes, attachments, or checkpoints
- navigation that should survive session splits, forks, or rewrites

If that day comes, the right move is:

```text
Workstream/Case/Project (new object)
  -> many Sessions
    -> many Runs
```

Not:

```text
A task-like workflow artifact becomes the hidden real object
and Session becomes a chat attachment hanging off it
```

In other words: if RemoteLab grows a second layer, it should be an explicit parent above sessions, not a shadow workflow artifact beside sessions.

---

## Practical Product Guidance

For current feature work, these defaults should hold:

- if the owner wants a richer workflow view later, improve session metadata and derivation first
- if the owner wants better recall after many delegated conversations, improve session naming / grouping / descriptions / summaries first
- if the owner wants easier attention management, improve workflow projection first
- if a proposal needs its own object, ask whether it truly survives beyond any one session

This keeps RemoteLab aligned with its core product identity:

> durable AI work is centered on sessions, and workflow organization is built around them rather than replacing them.
