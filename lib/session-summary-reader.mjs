import { createHash } from 'node:crypto';

const etag = session => `"${createHash('sha1').update(JSON.stringify({ session })).digest('hex')}"`;

// Shared by all consumers of one authenticated HTTP client. Membership and
// ordering come from the current lightweight index; only changed summaries
// are fetched. A failed refresh never commits a partially updated cache.
export function createSessionSummaryReader(requestJson) {
  let records = null, pending = null;
  async function refresh() {
    if (!records) {
      const response = await requestJson('/api/sessions');
      if (!Array.isArray(response?.sessions)) throw new Error('Session summaries unavailable');
      records = new Map(response.sessions.map(session => [session.id, { session, etag: etag(session) }]));
      return response.sessions;
    }
    const response = await requestJson('/api/sessions?view=refs');
    if (!Array.isArray(response?.sessionRefs)) throw new Error('Session summary index unavailable');
    const next = new Map();
    for (let start = 0; start < response.sessionRefs.length; start += 8) {
      const batch = await Promise.all(response.sessionRefs.slice(start, start + 8).map(async ref => {
        const old = records.get(ref.id);
        if (old?.etag === ref.summaryEtag) return [ref.id, old];
        const detail = await requestJson(`/api/sessions/${encodeURIComponent(ref.id)}?view=summary`);
        return [ref.id, detail?.session ? { session: detail.session, etag: ref.summaryEtag } : null];
      }));
      for (const [id, record] of batch) if (record) next.set(id, record);
    }
    records = next;
    return [...records.values()].map(record => record.session);
  }
  return { async read() {
    if (pending) return pending;
    pending = refresh();
    try { return await pending; } finally { pending = null; }
  } };
}
