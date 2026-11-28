import { createHash } from 'node:crypto';
import { setImmediate as yieldToIO } from 'node:timers/promises';

const hash = value => `"${createHash('sha1').update(value).digest('hex')}"`;
const encode = session => {
  const json = JSON.stringify(session);
  return { session, json, ref: JSON.stringify({ id: session.id, summaryEtag: hash(`{"session":${json}}`) }) };
};
const scopeHints = new Set(['people_updated', 'instance_settings_updated']);
const versionHints = new Set(['sessions_invalidated', ...scopeHints, 'connectors_updated', 'local_bridge_updated']);
const surfaceHints = { connectors_updated: 'connectors', local_bridge_updated: 'localBridge' };

// One viewer-independent projection. Filter and apply the viewer's overlay
// before encoding any row; IDs/refs and archived counts use the same ACL.
export function createSessionListCache({ loadAll, loadOne, loadVersions, project = item => item,
  now = Date.now, versionPollMs = 60_000, maxViews = 8 } = {}) {
  let records = null, versions = null, pending = null, lastCheck = -Infinity, check = true;
  let sessionListFullLoads = 0, sessionListResponses = 0;
  const views = new Map(), dirty = new Set(), hot = new Set();
  let hotReadAt = now();
  function invalidate(message) {
    if (message.type === 'session_invalidated' && message.sessionId) dirty.add(message.sessionId);
    if (versionHints.has(message.type) || (message.type === 'session_invalidated' && !message.sessionId)) check = true;
    if (scopeHints.has(message.type)) views.clear();
    const surface = surfaceHints[message.type];
    if (surface) for (const [id, row] of records || []) {
      // Global transport changes affect only sessions eligible for that surface,
      // including sessions that did not have a connected surface before.
      if (row[surface] || row.sourceId !== 'chat' || (surface === 'localBridge' && row.folder)) dirty.add(id);
    }
  }
  function refresh({ checkVersions = true } = {}) {
    if (pending) return pending;
    if (now() - hotReadAt >= 1000) {
      for (const id of hot) dirty.add(id);
      hotReadAt = now();
    }
    const checkNow = loadVersions && (checkVersions || check || now() - lastCheck >= versionPollMs);
    if (records && !dirty.size && !checkNow) return;
    const batch = new Set(dirty);
    dirty.clear();
    if (checkNow) check = false;
    pending = (async () => {
      try {
        const next = checkNow ? await loadVersions() : versions;
        const rebuild = !records || (versions && next && (next.catalogSchema !== versions.catalogSchema
          || (Number.isInteger(next.catalogRevision) && next.catalogRevision < versions.catalogRevision)));
        if (rebuild) {
          sessionListFullLoads++;
          const all = await loadAll();
          records = new Map(all.map(s => [s.id, s]));
          hot.clear();
          for (const s of all) if (isHot(s)) hot.add(s.id);
          views.clear();
        } else {
          if (versions && next && next !== versions) {
            for (const [id, version] of next) if (versions.get(id) !== version) batch.add(id);
            for (const id of versions.keys()) if (!next.has(id)) batch.add(id);
          }
          if (batch.size) {
            const ids = [...batch];
            for (let n = 0; n < ids.length; n += 16) {
              const changed = await Promise.all(ids.slice(n, n + 16).map(async id => [id, await loadOne(id)]));
              for (const [id, item] of changed) {
                if (item) records.set(id, item); else records.delete(id);
                if (isHot(item)) hot.add(id); else hot.delete(id);
                for (const view of views.values()) {
                  view.rows.delete(id);
                  view.responses.clear();
                }
              }
              if (n + 16 < ids.length) await yieldToIO();
            }
          }
        }
        versions = next;
        if (checkNow) lastCheck = now();
      } catch (error) {
        if (checkNow) check = true;
        for (const id of batch) dirty.add(id);
        throw error;
      }
    })().finally(() => { pending = null; });
    return pending;
  }
  async function read({ personId = '', sourceId = '', folder = '', archived = false, refs = false,
    withRefs = false, accessRevision = null } = {}) {
    // A hint arriving during disk I/O must not be lost. It remains pending for
    // the next read, independently from requests already using this snapshot.
    await refresh();
    let view = views.get(personId);
    if (!view || view.accessRevision !== accessRevision) {
      view = { rows: new Map(), responses: new Map(), accessRevision };
      views.delete(personId);
      views.set(personId, view);
      if (views.size > maxViews) views.delete(views.keys().next().value);
    }
    view.readAt = now();
    sessionListResponses++;
    const key = JSON.stringify([sourceId, folder, archived, refs, withRefs]);
    if (view.responses.has(key)) return view.responses.get(key);
    const selected = [];
    let archivedCount = 0;
    for (const [id, item] of records) {
      if ((sourceId && item.sourceId !== sourceId) || (folder && item.folder !== folder)) continue;
      if (!view.rows.has(id)) {
        const session = project(item, personId, accessRevision);
        view.rows.set(id, session ? { session } : null);
      }
      const row = view.rows.get(id);
      if (!row) continue;
      if (row.session.archived === true) archivedCount++;
      if ((row.session.archived === true) === archived) {
        if (!row.encoded) row.encoded = encode(row.session);
        selected.push(row.encoded);
      }
    }
    selected.sort(({ session: a }, { session: b }) => {
      if (a.sidebarOrder && b.sidebarOrder && a.sidebarOrder !== b.sidebarOrder) return a.sidebarOrder - b.sidebarOrder;
      return Number(b.pinned === true) - Number(a.pinned === true)
        || (Date.parse(b.updatedAt || b.created) || 0) - (Date.parse(a.updatedAt || a.created) || 0);
    });
    const pairedRefs = withRefs && !refs ? `,"sessionRefs":[${selected.map(r => r.ref).join(',')}]` : '';
    const body = `{"${refs ? 'sessionRefs' : 'sessions'}":[${selected.map(r => refs ? r.ref : r.json).join(',')}],"archivedCount":${archivedCount}${pairedRefs}}`;
    const response = { body, etag: hash(body) };
    view.responses.set(key, response);
    if (view.responses.size > 16) view.responses.delete(view.responses.keys().next().value);
    return response;
  }
  function sweepIdle(maxIdleMs, at = now()) {
    let released = 0;
    for (const [key, view] of views) {
      if (at - view.readAt < maxIdleMs) continue;
      views.delete(key); released++;
    }
    return released;
  }
  function takeMetrics() {
    const result = { sessionListFullLoads, sessionListResponses };
    sessionListFullLoads = 0; sessionListResponses = 0;
    return result;
  }
  return { read, invalidate, sweepIdle, takeMetrics,
    checkVersions: () => records ? refresh({ checkVersions: false }) : undefined };
}

function isHot(session) {
  return session?.activity?.run?.state === 'running' || session?.activity?.queue?.count > 0
    || session?.activity?.compact?.state === 'pending' || Boolean(session?.localBridge);
}
