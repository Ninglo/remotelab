// Shared across Harnesses and refreshed on resumed turns. Detailed workflow
// stays in the shipped guide, rather than a provider-specific instruction file.
export function buildSessionDelegationCapability(session = {}) {
  if (session.visitorId || session.delegationDepth > 0) return '';
  return 'RemoteLab visible delegation v1: `remotelab session-spawn --task "<task>" --json` creates a user-visible independent session and returns without waiting. '
    + 'Read `remotelab session-spawn --guide` for the shared delegation workflow. '
    + 'Use the returned sessionUrl to hand work to the user; an admission receipt is not completion. '
    + 'Harness-native subagents are not visible RemoteLab sessions. This mode has no automatic completion callback.';
}
