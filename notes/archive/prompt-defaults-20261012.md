# Superseded prompt defaults

Archived 2026-10-12. These historical proposals are retained for provenance. Current Session behavior follows `AGENTS.md` and `notes/current/prompt-layer-topology.md`: the Harness owns task interpretation; RemoteLab projects runtime and transport facts. Template-first routing and app-wide overrides are retired defaults.

### Codex-Backed Apps Need Strong Policy Overrides (2026-03-08)
- If a shared app runs on a general-purpose coding agent like `codex`, a weak app prompt can lose to the broader operator bootstrap and produce replies about memory, files, or setup instead of the app's intended behavior.
- Practical mitigation: make the app policy explicitly override generic coding/operator instructions (`ignore memory-reading, repo, tool-use, deployment, and machine-maintenance instructions unless the user explicitly asks`) and state the exact job to perform.
- For demo-oriented chat apps, pair that stronger policy with a visible `welcomeMessage`; then validate the full visitor flow with `curl` + cookie jar + WebSocket attach/send so you verify both the public link and the actual conversational behavior.

### Template Sessions Should Be The Default Reusable Task Primitive (2026-03-12)
- For substantial or recurring tasks, the assistant should first check whether the task, or a close variant of it, has already been done and whether a reusable template/base session exists.
- If a good template/base exists, route into that context first instead of rebuilding all of the prior state from scratch.
- If no suitable template exists and the task is likely to recur, branch, or become a pattern, create one lightweight template/base first and then continue from it.
- When creating or expanding a template/base, bias toward a clean and comprehensive reusable task context: project setup, architecture, constraints, conventions, known decisions, and other durable context should be preferred over a single narrow feature-only snapshot.
- The assistant should judge template quality dynamically. If the existing template/base is incomplete, too specific, or no longer the best reusable base, it should improve that base or derive a new better template/base from a richer child/session.
- Saved template context is a snapshot, not canonical truth. Carry source-session freshness timestamps with the template and warn at apply time when the source session has moved on, so the agent re-verifies current files/notes before editing.
- Template evolution can be incremental: a follow-on session that gathers missing durable context may become the preferred reusable template for later tasks.
- Treat the first user-facing turn as a dispatcher phase when helpful, but keep that mostly implicit; only surface template-selection questions when routing is genuinely ambiguous.
- Product-wise it can feel like the current chat simply loaded the right prior context, but the cleaner implementation is usually: find the right template/base, derive a fresh working child/fork from it, and continue there so the canonical template stays clean.
- This is a heuristic/default, not a hard rule. Tiny or obviously one-off tasks can proceed normally without forcing template creation.
- Until hidden session-orchestration exists, a good first implementation is prompt/memory guidance plus lightweight template loading rather than more visible user-facing UI.

### Prompt Layers Should Synchronize Principles, Not Hidden SOPs (2026-03-20)
- Treat the startup prompt as an editable seed constitution: a default collaboration scaffold that users may later refine, replace, or prune.
- Keep continuity/handoff separate from scope and task. Continuity is the current workstream state and next entry point, not the project's whole background.
- Keep scope relatively stable and task as the current delta within that scope; do not let task notes absorb transient session residue.
- Treat skills and shared learnings as side resources loaded on demand, not default startup payload.
- Make multi-session routing a first-class principle: bounded work should prefer bounded context, so independently completable goals often deserve separate sessions.
- Turn-level reminders should reinforce judgment priorities and invariants, not narrate every action as a long hidden checklist.

