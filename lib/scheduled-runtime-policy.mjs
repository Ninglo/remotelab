import { normalizeRuntimeProfile, resolveRuntimeProfile } from './runtime-profile.mjs';

// Legacy nonempty profiles may have been explicit selections. Preserve them;
// empty legacy profiles mean Default, never a snapshot of a product fallback.
export function scheduledRuntimePolicy(record = {}) {
  if (record.runtimePolicy) {
    if (!['follow_default', 'fixed'].includes(record.runtimePolicy)) {
      throw new Error('runtimePolicy must be follow_default or fixed');
    }
    return record.runtimePolicy;
  }
  return Object.values(normalizeRuntimeProfile(record)).some(Boolean) || record.thinking === true
    ? 'fixed' : 'follow_default';
}

export function scheduledRuntimeIntent(record = {}) {
  const runtimePolicy = scheduledRuntimePolicy(record);
  if (runtimePolicy === 'follow_default') {
    return { runtimePolicy, tool: '', model: '', effort: '', thinking: false };
  }
  return { runtimePolicy, ...normalizeRuntimeProfile(record), thinking: record.thinking === true };
}

export function patchScheduledRuntime(current, patch) {
  const fields = ['runtimePolicy', 'tool', 'model', 'effort', 'thinking'];
  if (!fields.some(field => Object.hasOwn(patch, field))) return {};
  if (Object.hasOwn(patch, 'thinking') && typeof patch.thinking !== 'boolean') {
    throw new Error('thinking must be a boolean');
  }
  const runtimePolicy = Object.hasOwn(patch, 'runtimePolicy')
    ? scheduledRuntimePolicy(patch)
    : scheduledRuntimePolicy(patch) === 'fixed' ? 'fixed' : scheduledRuntimePolicy(current);
  return scheduledRuntimeIntent({ ...current, ...patch,
    ...resolveRuntimeProfile(current, patch, ''), runtimePolicy });
}
