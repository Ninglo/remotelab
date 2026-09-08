// Defaults apply only to unbound group messages; explicit commands and thread
// bindings retain their existing routing semantics.
export function normalizeFeishuSessionPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sessionPolicy must be an object');
  }
  const mode = (input, key) => {
    if (!['fork', 'continue'].includes(input)) throw new Error(`Unsupported ${key}: ${input}`);
    return input;
  };
  const groups = value.groups ?? {};
  if (typeof groups !== 'object' || !groups || Array.isArray(groups)) {
    throw new Error('sessionPolicy.groups must be a chat-ID to mode object');
  }
  return {
    defaultMode: mode(value.defaultMode ?? 'fork', 'sessionPolicy.defaultMode'),
    groups: Object.fromEntries(Object.entries(groups).map(([chatId, setting]) => {
      if (!chatId.trim()) throw new Error('sessionPolicy.groups requires nonempty chat IDs');
      return [chatId, mode(setting, `sessionPolicy.groups.${chatId}`)];
    })),
  };
}

export function resolveFeishuSessionMode(config, summary) {
  const policy = normalizeFeishuSessionPolicy(config?.sessionPolicy);
  return Object.hasOwn(policy.groups, summary.chatId)
    ? policy.groups[summary.chatId] : policy.defaultMode;
}
