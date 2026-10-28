import { createWorkboardCheckpointStore } from './workboard-checkpoint.mjs';

// Keep durable projection/cursors separate from evictable event arrays. A
// route with more Sessions than maxSessions must still finish each long scan.
export function createWorkboardEventReader(requestJson, {
  maxSessions = 128, maxPages = 4, checkpointDir = '',
} = {}) {
  const store = checkpointDir ? createWorkboardCheckpointStore(checkpointDir) : null;
  const states = new Map();
  const payloads = new Map();
  async function stateFor(id) {
    if (!states.has(id)) states.set(id, { loading: store ? store.load(id)
      : Promise.resolve({ version: 1, afterSeq: 0, acknowledgedSeq: -1, renderKey: '', pages: [] }) });
    const holder = states.get(id);
    if (!holder.state) {
      try { holder.state = await holder.loading; }
      catch (error) { if (states.get(id) === holder) states.delete(id); throw error; }
    }
    return holder;
  }
  function remember(id, events) {
    payloads.delete(id); payloads.set(id, events);
    // Without a durable store, keep incomplete projections: throwing them
    // away would lose both correctness and forward progress.
    if (store) while (payloads.size > maxSessions) payloads.delete(payloads.keys().next().value);
  }
  async function read(sessionId, { skipAcknowledged = false, renderKey = '', force = false } = {}) {
    const holder = await stateFor(sessionId);
    if (holder.pending) return holder.pending;
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/events`;
    holder.pending = (async () => {
      let hasMore = false;
      let events = payloads.get(sessionId);
      for (let page = 0; page < maxPages; page++) {
        const cursor = holder.state.afterSeq;
        const response = await requestJson(`${path}?filter=all&afterSeq=${cursor}&limit=2000&includeBodies=false${store ? '&cacheRead=false' : ''}`);
        if (Number.isSafeInteger(response.headSeq) && response.headSeq < cursor) {
          const reset = { version: 1, afterSeq: 0, acknowledgedSeq: -1, renderKey: '', pages: [] };
          if (store) await store.save(sessionId, reset);
          holder.state = reset; events = undefined; payloads.delete(sessionId);
          hasMore = true;
          continue;
        }
        const additions = (response.events || []).filter(event => Number.isSafeInteger(event.seq) && event.seq > cursor);
        const projected = [];
        // Failed hydration/persistence advances no cursor. Keep authorization
        // headers and legacy surface markers, never tool/reasoning bodies.
        for (let start = 0; start < additions.length; start += 8) {
          projected.push(...await Promise.all(additions.slice(start, start + 8).map(async event => {
            if (event.type === 'message' && event.role === 'assistant') {
              if (event.bodyAvailable && event.bodyLoaded === false) {
                const body = await requestJson(`${path}/${event.seq}/body${store ? '?cacheRead=false' : ''}`);
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
        const seen = additions.reduce((seq, event) => Math.max(seq, event.seq), cursor);
        const next = Number.isSafeInteger(response.nextAfterSeq) ? Math.max(seen, response.nextAfterSeq) : seen;
        hasMore = response.hasMore === true;
        if (hasMore && next <= cursor) throw new Error(`Card history cursor did not advance: ${sessionId}`);
        if (next > cursor) {
          const previous = holder.state;
          const updated = store ? await store.append(sessionId, previous, projected, next)
            : { ...previous, afterSeq: next };
          // Persisted pages are sufficient until projection is needed. On an
          // evicted read, don't reload the whole prefix between every page.
          if (events) for (const event of projected) events.push(event);
          else if (!store) events = projected;
          holder.state = updated;
        }
        if (!hasMore) break;
      }
      const state = holder.state;
      if (skipAcknowledged && !force && !hasMore && state.acknowledgedSeq === state.afterSeq && state.renderKey === renderKey) {
        return { events: null, afterSeq: state.afterSeq, hasMore: false };
      }
      if (skipAcknowledged && hasMore) return { events: null, afterSeq: state.afterSeq, hasMore };
      if (!events) events = store ? await store.events(sessionId, state) : [];
      remember(sessionId, events);
      return { events, afterSeq: state.afterSeq, hasMore };
    })();
    try { return await holder.pending; }
    finally { holder.pending = null; }
  }
  async function acknowledge(id, afterSeq, renderKey = '') {
    const holder = await stateFor(id);
    if (afterSeq !== holder.state.afterSeq) throw new Error('Workboard projection changed before acknowledgement');
    const next = { ...holder.state, acknowledgedSeq: afterSeq, renderKey };
    if (store) await store.save(id, next);
    holder.state = next;
  }
  return { read, acknowledge };
}
