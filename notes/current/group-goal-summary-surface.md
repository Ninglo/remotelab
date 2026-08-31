# Group Goal Summary Surface

Status: current product exploration, isolated from the shipped main flow

## Core Decision

RemoteLab should test goal-oriented work recovery without introducing a separate first-class `Goal` object yet.

The near-term shape is:

```text
Group as the user's work item / goal surface
  -> derived AI summary and detail projection
  -> existing Sessions remain the execution threads
```

This keeps the product compatible with the current session-first architecture while making the user entry point more outcome-oriented.

## What Changes

Today, `group` is mostly a lightweight label over sessions.

This exploration treats a group as a thicker user-facing work surface:

- current goal or work item
- current status
- most important blockers
- recommended next actions
- recent changes
- supporting evidence
- associated sessions
- outputs and assets when available

The key product shift is not a new backend object. It is a new default projection over existing grouped sessions.

## What Does Not Change

- `Session` remains the durable execution object.
- The existing conversation page remains the place where concrete work is done.
- `Group` does not become a permission boundary.
- The summary/detail surface must not silently own truth that cannot be traced back to sessions, runs, artifacts, or explicit group metadata.
- Background AI roles such as "teacher" or "agent persona" should stay hidden from the user-facing model.

## User Flow

1. User enters a grouped work item.
2. Default landing is the summary page.
3. Summary page answers:
   - what this work item is
   - current status
   - current blocker
   - next recommended action
   - what changed recently
   - why the system believes this
4. If the summary is enough, the user clicks an action and enters the relevant session.
5. If the user wants the full picture, they open detail.
6. Detail shows fuller state, all sessions, decisions, outputs, and evidence.
7. The existing session page handles the concrete conversation and execution.

## Renderer Contract

The UI should render known modules from a structured group projection. The model or projection engine may generate content, but it must not generate arbitrary UI.

Minimum projection shape:

```json
{
  "groupKey": "RemoteLab Product",
  "title": "RemoteLab Product",
  "goal": "Make RemoteLab easier to use for real work recovery and execution",
  "status": {
    "label": "Needs review",
    "tone": "warning",
    "summary": "Several active sessions need attention or a next decision."
  },
  "blockers": [
    {
      "title": "One session is waiting for user input",
      "reason": "A work summary or workflow state indicates the next step needs confirmation.",
      "severity": "medium",
      "sourceSessionId": "..."
    }
  ],
  "actions": [
    {
      "title": "Open the session that needs a decision",
      "reason": "This is the most direct way to move the group forward.",
      "type": "open_session",
      "targetSessionId": "...",
      "expectedOutcome": "Resolve the current blocker and refresh the group summary."
    }
  ],
  "recentChanges": [
    "A session was updated 12 minutes ago."
  ],
  "evidence": [
    {
      "label": "Work summary from the latest session",
      "sessionId": "..."
    }
  ]
}
```

## Module Set

Summary page modules:

- text-first work brief that explains current status in plain language
- 2-3 most important focus points such as blocker, next action, and latest change
- one primary action into the relevant existing session
- a small related-session strip, not a full session listing
- collapsed evidence / recent-change drawer for users who want more context
- link to detail

Detail page modules:

- goal / work item definition
- full session list
- status distribution
- work summaries and next steps
- blockers / needs from user
- decisions and assumptions when available
- output / artifact list
- recent activity timeline

Session page integration:

- show the owning group / work item
- show what action this session is meant to solve
- after completion, update the group projection

## Implementation Posture

The first implementation should run as an isolated test service and read current RemoteLab data rather than mutate the shipped main flow.

Use a deterministic projection engine first, backed by real session metadata and work summaries. Keep the API schema model-ready so the deterministic engine can later be replaced or supplemented by an AI generator.

The semantic summary itself should be AI-generated, not assembled mechanically from status counters. Deterministic code should provide the facts, candidate actions, source digest, cache invalidation, and rendering contract; the AI layer should synthesize the project brief, focus points, user-needed information, confidence note, and best next action.

Recommended refresh timing:

- after a session turn updates group-relevant metadata, work summary, artifact, workflow state, or title
- when the group source digest changes and the user opens the summary page
- when the user manually refreshes the AI brief
- after a selected action returns from the session page and the group projection is revisited

## Isolated Test Implementation

An isolated functional test service now exists outside the main `7690` RemoteLab service:

- public surface: `https://goalflow.jiujianian-dev-world.win/`
- local process: `goalflow-demo.service` on `127.0.0.1:7810`
- source: owner workspace `goalflow-demo`

This service is read-only. It reads the real `chat-sessions.json` and `file-assets` metadata, groups active sessions by existing `group`, and renders:

- summary page as a concise text work brief with focus points, one primary action, a few related sessions, and collapsed evidence
- detail page for all sessions, work-summary content, and assets
- links from suggested actions back into the existing RemoteLab session page
- cached AI project brief generation through Codex CLI, keyed by the group source digest

The test UI should visually stay close to the existing RemoteLab chat theme. It reuses the same core tokens and interaction patterns where practical, including the header, sidebar group folding, neutral surfaces, and theme preference names. Multiple group/work-item entries should be collapsible so the summary view does not become a long project-management board.

The current projection engine is deterministic and schema-shaped. It is intentionally not a final product implementation; its job is to validate whether a goal-oriented group summary can improve work recovery without adding a separate user-facing Goal/teacher/workstream model.
