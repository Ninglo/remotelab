# Session State Audit

Status: current simplified contract.

Backend `session.activity` now exposes only orthogonal live control-plane activity:

- `activity.run.state` / `activity.run.phase`
- `activity.queue.state` / `activity.queue.count`
- `activity.compact.state`

Semantic post-turn state is durable Session metadata maintained by the single Session-state classifier:

- title / Space / Project group / description
- workflow state / priority
- `workSummary`, projected as `workState.summary`

The former continuation/checking activity and rename-pending activity were removed with pre-turn dispatch and early model-based renaming.

Historical audit: `notes/archive/session-state-audit.md`.
Current architecture: `notes/current/thin-control-plane-architecture.md`.
