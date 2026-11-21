import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { readRecord } from './durable-records.mjs';
import { normalizeRuntimeProfile } from './runtime-profile.mjs';

export function hasAutomationRuntimeSelection(input = {}) {
  return ['runtimePolicy', 'tool', 'model', 'effort', 'thinking'].some(field => Object.hasOwn(input, field));
}

export async function readAutomationRuntimeDefault() {
  const value = await readRecord(join(CONFIG_DIR, 'automation-runtime-default.json'));
  if (value === null) return null;
  const { tool, model, effort } = normalizeRuntimeProfile(value);
  if (value.version !== 1 || !tool || !model || model === 'auto' || !effort) {
    throw new Error('Invalid instance automation runtime default');
  }
  return { runtimePolicy: 'fixed', tool, model, effort, thinking: false };
}

// Only at creation, never when reading or executing an existing task.
export async function withAutomationRuntimeDefault(input) {
  if (hasAutomationRuntimeSelection(input)) return input;
  const profile = await readAutomationRuntimeDefault();
  return profile ? { ...input, ...profile } : input;
}
