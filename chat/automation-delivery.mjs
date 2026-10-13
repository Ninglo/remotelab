import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { createSerialTaskQueue, writeJsonAtomic } from './fs-utils.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';

const path = join(CONFIG_DIR, 'automation-delivery-settings.json');
const serial = createSerialTaskQueue();
async function readSettings() {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value.version !== 1 || !value.tasks || typeof value.tasks !== 'object' || Array.isArray(value.tasks)) throw new Error('Invalid automation delivery settings');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, tasks: {} }; throw error; }
}

// Read at admission, including occurrences generated before the setting changed.
// Accepted requests retain their snapshotted delivery plan.
export async function automationDeliveryOptions(trigger) {
  const setting = (await readSettings()).tasks[trigger.scheduleId || trigger.id];
  return setting?.enabled === false ? { suppressSourceDelivery: true } : {};
}

export async function setAutomationDelivery(task, input, actor = {}) {
  if (task.resultDelivery?.mode !== 'conversation') throw new Error('This task has no platform result delivery target');
  if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedRevision)) throw new Error('enabled and expectedRevision are required');
  return serial(async () => {
    const settings = await readSettings();
    const current = settings.tasks[task.id] || { revision: 0, enabled: true };
    if (input.expectedRevision !== current.revision) throw Object.assign(new Error('Delivery setting changed; reload before editing'), { status: 409 });
    const next = { enabled: input.enabled, revision: current.revision + 1,
      updatedAt: new Date().toISOString(), personId: actor.personId || '', identityId: actor.identityId || '' };
    settings.tasks[task.id] = { ...next, history: [...(current.history || []), { ...next, previousEnabled: current.enabled }].slice(-32) };
    await writeJsonAtomic(path, settings, { mode: 0o600 });
    return next;
  });
}

export async function enrichAutomationDelivery(tasks, { sessions, settings } = {}) {
  [sessions, settings] = await Promise.all([sessions || loadSessionsMeta(), settings || readSettings()]);
  const names = new Map();
  for (const session of [...sessions].sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')))) {
    const c = session.conversation, s = session.sourceContext;
    if (c?.connector !== 'feishu' || !c.target?.chatId || s?.chatId !== c.target.chatId || !s.chatName) continue;
    if (s.sourceRouteId && s.sourceRouteId !== c.sourceRouteId) continue;
    names.set(`${c.sourceRouteId}:${c.target.tenantKey || s.tenantKey || ''}:${c.target.chatId}`, s.chatName);
    // Chat IDs are provider-unique; route remains part of the lookup scope.
    names.set(`${c.sourceRouteId}:${c.target.chatId}`, s.chatName);
  }
  for (const task of tasks) {
    const d = task.resultDelivery || {}, target = d.target || {};
    task.deliveryRecipient = target.chatName || target.name || target.label ||
      (d.connector === 'feishu' ? names.get(`${d.sourceRouteId}:${target.tenantKey || ''}:${target.chatId}`)
        || names.get(`${d.sourceRouteId}:${target.chatId}`) : '') || '';
    const setting = settings.tasks[task.id];
    task.deliveryControl = { supported: d.mode === 'conversation', enabled: setting?.enabled !== false, revision: setting?.revision || 0 };
  }
  return tasks;
}
