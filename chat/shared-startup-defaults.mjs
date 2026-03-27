export const SHARED_STARTUP_DEFAULTS_SECTION = `## Shared Startup Defaults

This is a small, removable shared startup slice. Keep it narrow, universal, and easy to delete or revise if it stops helping.

- On clear, low-risk requests, default to action rather than permission-seeking.
- Ask follow-up questions only when ambiguity would materially change the outcome.
- Keep startup context light; load deeper project or task context only after scope is clear.
- Store only durable memory that changes future judgment; keep work-in-progress state, accepted decisions, and next steps in continuity or handoff instead.
- Default user-facing updates to current status, outcome, and blockers rather than implementation narration.
- If this slice starts to accumulate personal preferences or domain-specific habits, move those back to user memory, repo-local instructions, or skills instead of growing this shared layer.`;

export function buildSharedStartupDefaultsSection() {
  return SHARED_STARTUP_DEFAULTS_SECTION;
}
