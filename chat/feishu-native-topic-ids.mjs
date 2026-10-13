import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const decimal = value => typeof value === 'string' && /^\d{16,20}$/.test(value);
const thread = value => typeof value === 'string' && /^omt_[a-f0-9]{16}$/.test(value);
const rootOf = s => s.conversation?.target?.rootId || s.conversation?.target?.messageId;

// This is an explicitly enrolled, versioned identifier namespace, not fuzzy
// matching of titles or summaries. Never learn a namespace from client input.
export function namespaceProfiles(document) {
  if (!document || document.version !== 1 || !Array.isArray(document.profiles)) return [];
  const valid = [], scopes = new Set();
  for (const p of document.profiles) {
    const scope = [p.route, p.tenantKey, p.appId].join(':');
    if (p.encoding !== 'thread-xor64-v1' || p.route !== 'bot-2' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.tenantKey || '') || !/^cli_[a-zA-Z0-9]+$/.test(p.appId || '') || !/^\d{1,20}$/.test(p.mask || '') || !Array.isArray(p.samples) || p.samples.length < 16 || p.samples.length > 1000) continue;
    const mask = BigInt(p.mask), ids = new Set(), roots = new Set(), groups = new Set();
    if (mask >= (1n << 64n)) continue;
    let good = true;
    for (const s of p.samples) {
      if (!thread(s.threadId) || !decimal(s.nativeId) || !/^om_[a-zA-Z0-9]+$/.test(s.rootId || '') || !/^oc_[a-zA-Z0-9]+$/.test(s.chatId || '') || !/^\d{10}$/.test(s.createdSeconds || '') || !/^\d+$/.test(String(s.position ?? '')) || ids.has(s.nativeId) || roots.has(s.rootId) || (BigInt(s.nativeId) ^ BigInt('0x' + s.threadId.slice(4))) !== mask || String(BigInt(s.nativeId) >> 32n) !== s.createdSeconds) { good = false; break; }
      ids.add(s.nativeId); roots.add(s.rootId); groups.add(s.chatId);
    }
    if (good && groups.size >= 3) valid.push(p);
    if (scopes.has(scope)) return []; // Conflicting/duplicated enrollment fails closed.
    scopes.add(scope);
  }
  return valid;
}

export async function nativeTopicBindings(sessions, wantedIds, config, configDir) {
  const bindings = { ...config.bindings }, profiles = namespaceProfiles(config.nativeNamespaces);
  if (!profiles.length) return bindings;
  const wanted = new Set(wantedIds), jobs = [];
  for (const s of sessions) {
    const c = s.conversation, t = c?.target, root = rootOf(s);
    if (c?.connector !== 'feishu' || t?.chatType !== 'group' || !thread(t.threadId) || !/^om_[a-zA-Z0-9]+$/.test(root || '')) continue;
    for (const p of profiles) {
      if (c.sourceRouteId !== p.route || t.tenantKey !== p.tenantKey) continue;
      const id = String(BigInt('0x' + t.threadId.slice(4)) ^ BigInt(p.mask));
      if (!decimal(id) || !wanted.has(id)) continue;
      jobs.push({ s, t, root, p, id });
    }
  }
  // Only read accepted first-post envelopes for IDs actually requested. No
  // browser, remote computer, provider token or per-topic API lookup is needed.
  const matches = [];
  for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(async j => {
    const { t, root, p, id } = j;
    const key = createHash('sha256').update(root).digest('hex').slice(0, 24);
    let record;
    for (const part of ['active', 'archive']) {
      try { const raw = await readFile(join(configDir, 'feishu-connectors', p.route, 'state/inbox', part, key + '.json'), 'utf8'); if (raw.length > 2 * 1024 * 1024) return; record = JSON.parse(raw); break; }
      catch (e) { if (e.code !== 'ENOENT') return; }
    }
    const m = record?.summary, c = record?.submission?.payload?.sourceContext;
    if (record?.id !== root || m?.messageId !== root || m.rootId || m.parentId || m.chatType !== 'group' || m.chatId !== t.chatId || m.tenantKey !== p.tenantKey || m.appId !== p.appId || m.threadId !== t.threadId || !/^\d{13}$/.test(String(m.createTime || ''))) return;
    if (c?.connector !== 'feishu' || c.sourceRouteId !== p.route || c.messageId !== root || c.chatId !== t.chatId || c.tenantKey !== p.tenantKey || c.threadId !== t.threadId || String(c.createTime) !== String(m.createTime)) return;
    if (String(BigInt(id) >> 32n) !== String(Math.floor(Number(m.createTime) / 1000))) return;
    matches.push(j);
  }));
  const owners = new Map();
  for (const [root, id] of Object.entries(bindings)) { const set = owners.get(id) || new Set(); set.add(root); owners.set(id, set); }
  for (const { root, id } of matches) { const set = owners.get(id) || new Set(); set.add(root); owners.set(id, set); }
  for (const { root, id } of matches) {
    if (bindings[root] && bindings[root] !== id) { delete bindings[root]; continue; }
    if (owners.get(id).size !== 1) { for (const owner of owners.get(id)) delete bindings[owner]; continue; }
    bindings[root] = id;
  }
  return bindings;
}
