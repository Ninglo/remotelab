// Purpose labels never change admission, authorization or alert policy.
export const AUTOMATION_PURPOSES = Object.freeze([
  'operations', 'projects', 'research', 'execution', 'memory', 'improvement', 'other',
]);

export function normalizeAutomationPurpose(value, { strict = false } = {}) {
  if (value == null || value === '') return null;
  if (AUTOMATION_PURPOSES.includes(value)) return value;
  if (strict) throw new Error('Invalid automation purpose');
  return null;
}
