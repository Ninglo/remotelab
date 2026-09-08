// Native typing is an optional projection of durable request activity. It is
// not attached to an inbound handler's lifetime and never drives AI state.
export function createWeChatRequestFeedback({ loadActivity, typing, resolveContextToken = target => target.contextToken || '',
  pollMs = 1000, report = () => {} }) {
  const leases = new Map();
  let timer = null;
  let pending = null;
  let stopped = false;
  function release(entry) {
    void Promise.resolve().then(() => entry.lease.stop()).catch(() => {});
  }
  function clear() {
    for (const entry of leases.values()) release(entry);
    leases.clear();
  }
  async function refresh() {
    try {
      const activity = await loadActivity();
      if (stopped) return;
      if (!Array.isArray(activity)) throw new Error('Invalid activity response');
      const desired = new Map();
      for (const record of activity) {
        const target = record?.target;
        if (record.connector !== 'wechat' || !target?.accountId || !target.peerUserId) continue;
        const summary = { ...target, contextToken: resolveContextToken(target) };
        const key = JSON.stringify([summary.accountId, summary.peerUserId]);
        // The newest request supplies fresh context; all outstanding requests
        // to this peer share one feedback lease, including queued follow-ups.
        desired.set(key, { summary, signature: JSON.stringify([record.requestId, summary.contextToken]) });
      }
      for (const [key, entry] of leases) {
        if (!desired.has(key)) { release(entry); leases.delete(key); }
      }
      for (const [key, item] of desired) {
        const previous = leases.get(key);
        if (previous?.signature === item.signature) continue;
        const lease = typing.begin(item.summary);
        leases.set(key, { lease, signature: item.signature });
        // Acquire before release so a follow-up never cancels another task's typing.
        if (previous) release(previous);
      }
    } catch {
      // Loss of observation is not model failure. Stop stale decoration and
      // reconstruct it on the next successful scan, without touching requests.
      clear();
      try { report({ component: 'wechat_typing', operation: 'activity', state: 'unavailable' }); } catch {}
    }
  }
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (!pending) pending = refresh().finally(() => { pending = null; });
    return pending;
  };
  return {
    tick,
    start() {
      if (stopped || timer) return;
      timer = setInterval(() => void tick(), pollMs);
      timer.unref?.();
      void tick();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      clear();
      await Promise.all([pending, typing.close()]);
    },
  };
}
