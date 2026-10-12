import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_DIR } from '../lib/config.mjs';

// Instance-owned explanations, not instructions or another producer store.
export function automationDefinitionHash(task) {
  return createHash('sha256').update(JSON.stringify({
    prompt: task.prompt, schedule: { type: task.schedule?.type, cron: task.schedule?.cron,
      timezone: task.schedule?.timezone, everySeconds: task.schedule?.everySeconds },
    target: task.target, resultDelivery: task.resultDelivery,
  })).digest('hex');
}
const text = value => typeof value === 'string' ? value.slice(0, 1500) : '';
function safeUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
  catch { return ''; }
}
export async function listAutomationFlows(tasks, { path = join(CONFIG_DIR, 'automation-flows.json'), load = readFile } = {}) {
  let config;
  try { config = JSON.parse(await load(path, 'utf8')); if (config.version !== 1 || !Array.isArray(config.groups)) throw new Error('Invalid flow description'); }
  catch (error) { return { groups: [], unavailable: error.code !== 'ENOENT' }; }
  const byId = new Map(tasks.map(task => [task.id, task]));
  return { unavailable: false, groups: config.groups.filter(g => ['memory', 'tracking', 'knowledge'].includes(g?.id)).slice(0, 3).map(group => ({
    id: group.id, read: text(group.read), note: text(group.note),
    rows: (Array.isArray(group.rows) ? group.rows : []).filter(row => row && typeof row === 'object').slice(0, 20).map(row => {
      const ids = [...new Set((Array.isArray(row.taskIds) ? row.taskIds : []).filter(id => typeof id === 'string'))];
      return { title: text(row.title), taskIds: ids, process: text(row.process), write: text(row.write), send: text(row.send), note: text(row.note),
        needsReview: !ids.length || ids.some(id => !byId.has(id) || row.definitions?.[id] !== automationDefinitionHash(byId.get(id))),
        links: (Array.isArray(row.links) ? row.links : []).filter(l => l && typeof l === 'object').slice(0, 4).map(l => ({ title: text(l.title), url: safeUrl(l.url) })).filter(l => l.url && l.title),
      };
    }),
  })) };
}
