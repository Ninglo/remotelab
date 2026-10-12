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
export function automationBackgroundHash(item) {
  return createHash('sha256').update(JSON.stringify({ id: item.id, title: item.title, trigger: item.trigger, note: item.note })).digest('hex');
}
const text = value => typeof value === 'string' ? value.slice(0, 1500) : '';
function safeUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
  catch { return ''; }
}
export async function listAutomationFlows(tasks, { path = join(CONFIG_DIR, 'automation-flows.json'), load = readFile, backgroundMechanisms = [] } = {}) {
  let config;
  try { config = JSON.parse(await load(path, 'utf8')); if (config.version !== 1 || !Array.isArray(config.groups)) throw new Error('Invalid flow description'); }
  catch (error) { return { groups: [], unavailable: error.code !== 'ENOENT' }; }
  const byId = new Map(tasks.map(task => [task.id, task]));
  const backgroundById = new Map(backgroundMechanisms.map(item => [item.id, item]));
  return { unavailable: false, language: ['zh-CN', 'en'].includes(config.language) ? config.language : '', groups: config.groups.filter(g => ['operations', 'memory', 'tracking', 'knowledge'].includes(g?.id)).slice(0, 4).map(group => ({
    id: group.id, readAt: text(group.readAt), read: text(group.read), note: text(group.note),
    rows: (Array.isArray(group.rows) ? group.rows : []).filter(row => row && typeof row === 'object').slice(0, 20).map(row => {
      const ids = [...new Set((Array.isArray(row.taskIds) ? row.taskIds : []).filter(id => typeof id === 'string'))];
      const backgroundIds = [...new Set((Array.isArray(row.backgroundIds) ? row.backgroundIds : []).filter(id => typeof id === 'string'))];
      return { title: text(row.title), taskIds: ids, backgroundIds, process: text(row.process), write: text(row.write), writeDetails: text(row.writeDetails), send: text(row.send), note: text(row.note),
        needsReview: (!ids.length && !backgroundIds.length) || backgroundIds.some(id => !backgroundById.has(id) || row.definitions?.[id] !== automationBackgroundHash(backgroundById.get(id))) || ids.some(id => !byId.has(id) || row.definitions?.[id] !== automationDefinitionHash(byId.get(id))),
        links: (Array.isArray(row.links) ? row.links : []).filter(l => l && typeof l === 'object').slice(0, 4).map(l => ({ title: text(l.title), url: safeUrl(l.url) })).filter(l => l.url && l.title),
      };
    }),
  })) };
}
