// Opt-in delta frames keep a small status change from retransmitting every
// paired-group topic. Each connection starts with a full snapshot; reconnects
// never depend on a previous connection's sequence or cached state.
const ignored = new Set(['syncedAt', 'sourceUpdatedAt']);
export function createTopicStreamEncoder() {
  let previous, sequence = 0;
  return data => {
    if (!previous || data.sourceConnected === false) {
      previous = data;
      return { ...data, streamSequence: ++sequence };
    }
    const changes = [];
    const diff = (a, b, path) => {
      if (a === b) return;
      if (a && b && typeof a === 'object' && typeof b === 'object'
        && Array.isArray(a) === Array.isArray(b)
        && (!Array.isArray(a) || a.length === b.length)
        && Object.keys(a).every(k => Object.hasOwn(b, k))) {
        for (const key of Object.keys(b)) if (!ignored.has(key)) diff(a[key], b[key], [...path, key]);
      } else changes.push([path, b]);
    };
    diff(previous, data, []);
    if (!changes.length) return null;
    const base = sequence;
    previous = data;
    const patch = { type: 'topic-patch', base, streamSequence: ++sequence, syncedAt: data.syncedAt, changes };
    const full = { ...data, streamSequence: sequence };
    return changes.length <= 1000 && JSON.stringify(patch).length < JSON.stringify(full).length ? patch : full;
  };
}
