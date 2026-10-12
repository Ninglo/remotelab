import { buildPersonMemoryPromptBlock } from './person-memory-context.mjs';

// The accepted switch belongs to a Person; the procedure belongs to their
// profile. Shared code only routes to that record, never supplies a default
// procedure or borrows one from another participant in the same Session.
export function strictStartCheckPrompt(policy, { resetDisabled = false, personId = '', identityId = '',
  authDocument, memoryDir } = {}) {
  if (policy?.scope !== 'person' || policy.strictStartCheck !== true) return resetDisabled
    ? 'Strict work-start check is OFF for this accepted work; do not inherit it from Session history. Continue with the ordinary Harness workflow and current authorization.' : '';
  if (policy.personId !== personId || !buildPersonMemoryPromptBlock({ personId, identityId, authDocument, memoryDir })) {
    return 'The work-start preference has no matching verified requester. Do not inherit personal requirements from Session history; use the ordinary Harness workflow.';
  }
  return [
    'This requester enabled their personal work-start preference. Read the work-start requirements in their verified Person profile identified in Per-turn context; apply only what that record specifies for this task.',
    "There is no shared default checklist. If that profile has no work-start requirements, use the ordinary Harness workflow; never borrow another person's procedure. These checks do not require a separate user-facing report.",
  ].join('\n');
}
