// A navigation collection, independent of personal grouping and execution policy.
export function normalizeSessionCollection(value) {
  if (value == null || value === '') return '';
  if (value !== 'automations') throw new Error('sessionCollection must be automations or empty');
  return value;
}

export function canCollectAutomationSession(session) {
  return session?.internalRole === 'scheduled_execution' && !session.groupFeed;
}
