import { readFile, stat } from 'node:fs/promises';
import '../static/chat/session-state-model.js';

const text = value => typeof value === 'string' ? value.trim() : '';
// Service summaries project a service view. Read only the stored per-Person
// organization alongside them; runtime status always comes from the live API.
export function createProjectViewReader(filename) {
  let version = '', views = new Map(), pending;
  return { async read() {
    if (pending) return pending;
    pending = (async () => {
      const info = await stat(filename);
      const next = `${info.ino}:${info.size}:${info.mtimeMs}`;
      if (next === version) return views;
      const records = JSON.parse(await readFile(filename, 'utf8'));
      if (!Array.isArray(records)) throw new Error('Project views unavailable');
      const result = new Map(records.map(s => [s.id, s.personViews || {}]));
      views = result; version = next; return views;
    })();
    try { return await pending; } finally { pending = null; }
  } };
}

export function summarizeProjectSessions(sessions, { personId, identityIds, views }) {
  const groups = new Map();
  for (const session of sessions) {
    if (session.archived || session.internalRole || !identityIds.has(text(session.initiatedByIdentityId))) continue;
    const status = globalThis.RemoteLabSessionStateModel.getSessionPrimaryStatus(session).key;
    if (!['running', 'waiting', 'queued', 'compacting'].includes(status)) continue;
    const raw = text(views.get(session.id)?.[personId]?.group);
    const name = !raw || /^(loose|ungrouped)$/i.test(raw) ? '未归属项目' : raw;
    if (!groups.has(name)) groups.set(name, { name, running: 0, waiting: 0, queued: 0, compacting: 0, sessions: [] });
    const group = groups.get(name);
    group[status]++;
    group.sessions.push({ id: session.id, title: text(session.name) || '未命名 Session', status });
  }
  return [...groups.values()].sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name, 'zh-CN'));
}
