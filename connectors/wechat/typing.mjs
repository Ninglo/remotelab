// Native typing is ephemeral processing feedback, never a read receipt.
export function createWeChatTypingController({ getConfig, sendTyping, report = () => {},
  delayMs = 300, keepaliveMs = 5000 } = {}) {
  const targets = new Map();
  let closed = false;
  const emit = (operation, state) => {
    // Deliberately exclude provider errors, identities, tokens and tickets.
    try { report({ component: 'wechat_typing', operation, state }); } catch { /* logging cannot affect delivery */ }
  };
  function schedule(entry, ms) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => enqueue(entry), ms);
    entry.timer.unref?.();
  }
  async function reconcile(entry) {
    if (entry.users.size) {
      if (!entry.ticket) {
        try {
          const config = await getConfig(entry.summary);
          if (typeof config?.typing_ticket !== 'string' || !config.typing_ticket.trim()) {
            emit('getconfig', 'ticket_unavailable');
          } else {
            entry.ticket = config.typing_ticket;
            emit('getconfig', 'succeeded');
          }
        } catch { emit('getconfig', 'failed'); }
      }
      // A completed fast task or shutdown must not start after a late getconfig.
      if (entry.users.size && entry.ticket) {
        entry.attempted = true; // Even a timeout may have reached the provider.
        try {
          await sendTyping(entry.summary, entry.ticket, 1);
          emit('start', 'succeeded');
        } catch { emit('start', 'failed'); }
      }
    }
    if (!entry.users.size) {
      if (entry.attempted) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await sendTyping(entry.summary, entry.ticket, 2);
            emit('stop', 'succeeded');
            break;
          } catch { emit('stop', 'failed'); }
        }
        entry.attempted = false;
      }
      entry.ticket = '';
      if (!entry.users.size && targets.get(entry.key) === entry) targets.delete(entry.key);
      else if (entry.users.size) schedule(entry, delayMs);
    }
    // An unsupported or unavailable ticket must not hammer getconfig for a long task.
    // A fresh inbound message may retry; active tickets alone need periodic refresh.
    if (entry.users.size && entry.ticket) schedule(entry, keepaliveMs);
  }
  function enqueue(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.pending = entry.pending.then(() => reconcile(entry));
    return entry.pending;
  }
  return {
    begin(summary) {
      if (closed) return { stop: () => Promise.resolve() };
      const key = JSON.stringify([summary.accountId, summary.peerUserId]);
      let entry = targets.get(key);
      if (!entry) {
        entry = { key, summary, users: new Set(), ticket: '', attempted: false,
          pending: Promise.resolve(), timer: null };
        targets.set(key, entry);
        schedule(entry, delayMs);
      } else {
        entry.summary = summary;
        if (!entry.ticket && !entry.timer) schedule(entry, delayMs);
      }
      const user = Symbol();
      entry.users.add(user);
      let stopping;
      return { stop() {
        if (stopping) return stopping;
        entry.users.delete(user);
        stopping = entry.users.size ? Promise.resolve() : enqueue(entry);
        return stopping;
      } };
    },
    async close() {
      closed = true;
      await Promise.all([...targets.values()].map((entry) => {
        entry.users.clear();
        return enqueue(entry);
      }));
    },
  };
}

// The existing worker owns authentication and timeout enforcement; never expose this as a skill.
export function createWeChatTypingApi({ post, resolveAccount, baseInfo }) {
  async function request(summary, endpoint, payload) {
    const account = resolveAccount(summary);
    if (!account?.token) throw new Error('typing_binding_unavailable');
    const raw = await post({ baseUrl: account.baseUrl, token: account.token,
      endpoint: `ilink/bot/${endpoint}`, timeoutMs: 5000, label: 'wechatTyping',
      body: JSON.stringify({ ...payload, base_info: baseInfo() }) });
    const result = raw.trim() ? JSON.parse(raw) : {};
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || (result.ret !== undefined && result.ret !== 0)
      || (result.errcode !== undefined && result.errcode !== 0)) throw new Error('typing_provider_rejected');
    return result;
  }
  return {
    getConfig: (summary) => request(summary, 'getconfig', {
      ilink_user_id: summary.peerUserId, context_token: summary.contextToken || undefined,
    }),
    sendTyping: (summary, ticket, status) => request(summary, 'sendtyping', {
      ilink_user_id: summary.peerUserId, typing_ticket: ticket, status,
    }),
  };
}
