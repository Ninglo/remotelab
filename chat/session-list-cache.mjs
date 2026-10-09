import { createHash } from 'node:crypto';

const hash = value => `"${createHash('sha1').update(value).digest('hex')}"`;
const encode = session => {
  const json = JSON.stringify(session);
  return { session, json, ref: JSON.stringify({ id: session.id,
    summaryEtag: hash(`{"session":${json}}`) }) };
};

// Cold records are projected/encoded once, then only changed IDs are read.
// The bounded fallback is demand-driven recovery for an external writer that
// omitted its change hint, never a background polling job.
export function createSessionListCache({ loadAll, loadOne, loadVersions, now = Date.now,
  maxAgeMs = 300000, maxViews = 8 } = {}) {
  const views = new Map();
  function invalidate(message) {
    if (message.type === 'session_invalidated' && message.sessionId) {
      for (const view of views.values()) view.dirty.add(message.sessionId);
    } else if (['sessions_invalidated', 'instance_settings_updated', 'people_updated',
      'connectors_updated', 'local_bridge_updated'].includes(message.type)
      || (message.type === 'session_invalidated' && !message.sessionId)) {
      for (const view of views.values()) view.reset = true;
    }
  }
  async function refresh(view, personId) {
    if (view.pending) return view.pending;
    if (now() - view.hotReadAt >= 1000) {
      for (const id of view.hotIds) view.dirty.add(id);
      view.hotReadAt = now();
    }
    const reset = view.reset || now() - view.loadedAt >= maxAgeMs;
    if (!reset && !view.dirty.size) return;
    // Clear consumed hints before I/O: hints arriving during a read survive for
    // the next request, including a concurrent global invalidation.
    const dirty = [...view.dirty];
    view.dirty.clear();
    view.reset = false;
    view.pending = (async () => {
      try {
        if (reset) {
          view.records = new Map((await loadAll(personId)).map(s => [s.id, encode(s)]));
          view.loadedAt = now();
          view.hotIds.clear();
          for (const [id, { session: s }] of view.records) {
            if (isHot(s)) view.hotIds.add(id);
          }
        } else {
          const changed = await Promise.all(dirty.map(async id => [id, await loadOne(id, personId)]));
          for (const [id, session] of changed) {
            if (session) view.records.set(id, encode(session));
            else view.records.delete(id);
            if (isHot(session)) view.hotIds.add(id);
            else view.hotIds.delete(id);
          }
        }
        view.responses.clear();
      } catch (error) {
        view.reset ||= reset;
        for (const id of dirty) view.dirty.add(id);
        throw error;
      } finally { view.pending = null; }
    })();
    return view.pending;
  }
  async function read({ personId = '', sourceId = '', folder = '', archived = false,
    refs = false } = {}) {
    let view = views.get(personId);
    if (!view) {
      view = { records: new Map(), dirty: new Set(), hotIds: new Set(), hotReadAt: now(), reset: true, loadedAt: 0,
        responses: new Map(), pending: null };
      views.set(personId, view);
      if (views.size > maxViews) views.delete(views.keys().next().value);
    }
    if (loadVersions) {
      const versions = await loadVersions();
      if (view.versions && view.versions !== versions) {
        for (const [id, version] of versions) {
          if (view.versions.get(id) !== version) view.dirty.add(id);
        }
        for (const id of view.versions.keys()) if (!versions.has(id)) view.dirty.add(id);
      }
      view.versions = versions;
    }
    await refresh(view, personId);
    const key = JSON.stringify([sourceId, folder, archived, refs]);
    if (view.responses.has(key)) return view.responses.get(key);
    const filtered = [...view.records.values()].filter(({ session: s }) =>
      (!sourceId || s.sourceId === sourceId) && (!folder || s.folder === folder));
    const archivedCount = filtered.filter(({ session: s }) => s.archived === true).length;
    const selected = filtered.filter(({ session: s }) => (s.archived === true) === archived);
    selected.sort(({ session: a }, { session: b }) => {
      const orderA = a.sidebarOrder, orderB = b.sidebarOrder;
      if (orderA && orderB && orderA !== orderB) return orderA - orderB;
      return Number(b.pinned === true) - Number(a.pinned === true)
        || (Date.parse(b.updatedAt || b.created) || 0) - (Date.parse(a.updatedAt || a.created) || 0);
    });
    const body = `{"${refs ? 'sessionRefs' : 'sessions'}":[${selected.map(r => refs ? r.ref : r.json).join(',')}],"archivedCount":${archivedCount}}`;
    const response = { body, etag: hash(body) };
    view.responses.set(key, response);
    if (view.responses.size > 16) view.responses.delete(view.responses.keys().next().value);
    return response;
  }
  return { read, invalidate };
}

function isHot(session) {
  return session?.activity?.run?.state === 'running' || session?.activity?.queue?.count > 0
    || session?.activity?.compact?.state === 'pending' || Boolean(session?.localBridge);
}
