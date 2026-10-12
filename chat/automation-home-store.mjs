import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic, createKeyedTaskQueue } from './fs-utils.mjs';
const queue = createKeyedTaskQueue();
const pathFor = id => {
  if (!/^(sch|trg)_[a-f0-9]{24}$/.test(id)) throw new Error('Invalid automation task ID');
  return join(CONFIG_DIR, 'automation-homes', `${id}.json`);
};
export async function readAutomationHome(id) {
  try { return JSON.parse(await readFile(pathFor(id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export const mutateAutomationHome = (id, change) => queue(id, async () => {
  const current = await readAutomationHome(id);
  const next = await change(current);
  if (next) await writeJsonAtomic(pathFor(id), next);
  return next;
});
export function automationDefinition(record) {
  return Object.fromEntries(['id', 'title', 'text', 'createdAt', 'sourceSessionId', 'createdByIdentityId',
    'cron', 'timezone', 'cadence', 'lifetime', 'gate', 'sessionTemplate', 'runtimePolicy', 'tool', 'model', 'effort',
    'thinking', 'automationPolicy'].filter(key => record[key] !== undefined).map(key => [key, record[key]]));
}
