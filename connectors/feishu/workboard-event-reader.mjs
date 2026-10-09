// Card projection needs message text and event headers, never tool output or
// reasoning bodies. Keep those headers for legacy surface classification.
export function createWorkboardEventReader(requestJson, { maxSessions = 128, maxPages = 4 } = {}) {
  const sessions = new Map();
  async function read(sessionId) {
    let cached = sessions.get(sessionId);
    if (!cached) cached = { events: [], afterSeq: 0, pending: null };
    sessions.delete(sessionId);
    sessions.set(sessionId, cached);
    if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    if (cached.pending) return cached.pending;
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/events`;
    cached.pending = (async () => {
      let hasMore = false;
      for (let page = 0; page < maxPages; page++) {
        const response = await requestJson(`${path}?filter=all&afterSeq=${cached.afterSeq}&limit=2000&includeBodies=false`);
        const additions = (response.events || []).filter(event => Number.isSafeInteger(event.seq) && event.seq > cached.afterSeq);
        const projected = [];
        // Bound body reads too. Failed hydration leaves the page cursor intact,
        // so a retry cannot silently lose a progress/checklist message.
        for (let start = 0; start < additions.length; start += 8) {
          projected.push(...await Promise.all(additions.slice(start, start + 8).map(async event => {
            if (event.type === 'message' && event.role === 'assistant') {
              if (event.bodyAvailable && event.bodyLoaded === false) {
                const body = await requestJson(`${path}/${event.seq}/body`);
                if (!body.body || typeof body.body.value !== 'string') throw new Error(`Missing card message body: ${sessionId}:${event.seq}`);
                return { ...event, [body.body.field || 'content']: body.body.value, bodyLoaded: true };
              }
              return event;
            }
            if (event.type === 'message') return { ...event, content: '' };
            if (['status', 'source_delivery'].includes(event.type)) return event;
            return { seq: event.seq, type: event.type, timestamp: event.timestamp, runId: event.runId };
          })));
        }
        const seen = additions.reduce((seq, event) => Math.max(seq, event.seq), cached.afterSeq);
        const next = Number.isSafeInteger(response.nextAfterSeq) ? Math.max(seen, response.nextAfterSeq) : seen;
        cached.events.push(...projected);
        const progressed = next > cached.afterSeq;
        cached.afterSeq = next;
        hasMore = response.hasMore === true;
        if (!hasMore) break;
        if (!progressed) throw new Error(`Card history cursor did not advance: ${sessionId}`);
      }
      return { events: cached.events, hasMore };
    })();
    try { return await cached.pending; }
    finally { cached.pending = null; }
  }
  return { read };
}
