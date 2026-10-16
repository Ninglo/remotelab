// Small registered-group catalog + bounded metadata search. Semantic ownership
// remains with the Harness; discovery is never permission to send or resume.
import { routingPilotGroups } from '../lib/group-routing-pilot.mjs';
import { loadProjectMemoryRuntime } from './project-memory-runtime.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';
import { candidateWorkFromSessions } from './work-awareness-relevance.mjs';
import { getHistorySnapshot } from './history.mjs';
import { getRun } from './runs.mjs';
import { buildSessionNavigationHref } from '../lib/session-navigation.mjs';

const iso = value => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
};
export async function routingDiscovery(session, personId, { query = '', sessions, history = getHistorySnapshot, run = getRun } = {}) {
  const groups = await routingPilotGroups(session.conversation, personId);
  let config;
  try { config = (await loadProjectMemoryRuntime()).config; } catch { /* Names may be unavailable. */ }
  const catalog = groups.map(g => {
    const registered = config?.groups.find(p => p.sourceRouteId === g.route && p.chatId === g.chatId);
    return { ...g, name: registered?.chatName || g.name,
      projects: (registered?.projectIds || []).map(id => ({ id, name: config.projects.find(p => p.id === id)?.name || id })) };
  });
  if (!query.trim() || !groups.length) return { catalog, candidates: [] };
  const available = (sessions || await loadSessionsMeta()).filter(s => !s.groupFeed && !s.internalRole
    && s.conversation?.target?.tenantKey === session.conversation?.target?.tenantKey
    && groups.some(g => g.route === s.conversation?.sourceRouteId && g.chatId === s.conversation?.target?.chatId));
  const found = candidateWorkFromSessions(available, { sessionId: session.id, query, limit: 3 });
  const candidates = await Promise.all(found.map(async c => {
    const s = available.find(s => s.id === c.sessionId);
    const group = catalog.find(g => g.route === s.conversation.sourceRouteId && g.chatId === s.conversation.target.chatId);
    let snapshot;
    try { snapshot = await history(s.id, { metadataOnly: true }); } catch { /* Unknown remains unknown. */ }
    const works = [...(s.workAwareness?.works || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const open = works.find(w => ['active', 'blocked', 'paused'].includes(w.status));
    const latest = works[0];
    const lastUserMessageAt = iso(snapshot?.lastUserMessageAt);
    let execution;
    if (s.activeRunId) try { execution = await run(s.activeRunId); } catch { /* Unknown remains unknown. */ }
    const status = !snapshot || (s.activeRunId && !execution) ? 'unknown'
      : ['accepted', 'queued', 'running'].includes(execution?.state) ? execution.state
        : open?.status || (latest?.status === 'completed'
          && (!lastUserMessageAt || lastUserMessageAt <= iso(latest.updatedAt)) ? 'completed' : 'idle');
    return { sessionId: s.id, name: c.sessionName, goal: c.goal.slice(0, 300), group,
      status, matchedWorkStatus: c.status, archived: !!s.archived, createdAt: iso(s.created),
      lastUserMessageAt, lastWorkUpdateAt: iso(latest?.updatedAt),
      transfer: s.archived ? 'unavailable-archived' : 'requires-human-confirmation',
      sessionUrl: buildSessionNavigationHref(s.id),
      boundary: 'Candidate only. Read the original task and latest state; idle or recent does not authorize resuming it.' };
  }));
  return { catalog, candidates };
}
