import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRecord, writeDurableJson } from './durable-records.mjs';

const bindingPath = (root, sessionId) => join(root, 'session-bindings',
  createHash('sha256').update(sessionId).digest('hex') + '.json');

export async function readSessionAccount(root, sessionId) {
  const binding = await readRecord(bindingPath(root, sessionId));
  if (binding && (binding.version !== 1 || binding.sessionId !== sessionId || !binding.accountId)) {
    throw new Error('Invalid Codex Session account binding');
  }
  return binding;
}

export async function bindSessionAccount(root, sessionId, account, reason, now) {
  const binding = { version: 1, sessionId, accountId: account.id,
    identityId: account.identityId || '', reason, assignedAt: new Date(now).toISOString() };
  await writeDurableJson(bindingPath(root, sessionId), binding);
  return binding;
}

// Called under the account metadata lock before enabling allocation. Existing
// conversations retain their last observed authorization, including live runs.
export async function preserveExistingSessionAccounts(root, data, now) {
  const runsRoot = join(root, '..', 'chat-runs');
  let names;
  try { names = await readdir(runsRoot); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const latest = new Map();
  for (const name of names.filter(name => /^run_[a-f0-9]{24}$/.test(name))) {
    const run = await readRecord(join(runsRoot, name, 'status.json'));
    if (!run?.sessionId || !run.codexAccount?.id) continue;
    const previous = latest.get(run.sessionId);
    const stamp = run.codexAccount.selectedAt || run.startedAt || run.createdAt || '';
    if (!previous || stamp > previous.stamp) latest.set(run.sessionId, { stamp, id: run.codexAccount.id });
  }
  for (const [sessionId, { id }] of latest) {
    if (await readSessionAccount(root, sessionId)) continue;
    const account = data.accounts.find(account => account.id === id);
    if (account) await bindSessionAccount(root, sessionId, account, 'existing_session', now);
  }
}

export function accountUnavailableReason(account, binding, availability, now) {
  if (!account) return 'Session 绑定的 Codex 账号已不存在';
  if (binding?.identityId && account.identityId && binding.identityId !== account.identityId) {
    return 'Session 绑定的 Codex 登录身份已改变，请恢复原账号';
  }
  if (!account.account || account.usage?.status === 'signed_out') return 'Codex 账号未登录，请恢复登录';
  if (account.cooldownUntil > now) return 'Codex 账号正在限流冷却，请稍后重试';
  if (account.blockedUntil > now || availability(account.usage, '', now) === 'exhausted') {
    return 'Codex 账号额度已耗尽，请等待额度恢复';
  }
  return '';
}

// Callers serialize selection + liveness registration under one metadata lock.
// No provider RPC is performed on the foreground path.
export async function chooseSessionAccount(pool, data, sessionId, model, availability, excludedAccountIds = []) {
  const now = pool.now();
  const binding = await readSessionAccount(pool.root, sessionId);
  const excluded = new Set(excludedAccountIds);
  const excludedIdentities = new Set(data.accounts.filter(account => excluded.has(account.id))
    .map(account => account.identityId || account.id));
  const isExcluded = account => excluded.has(account.id) || excludedIdentities.has(account.identityId || account.id);
  let previous = null;
  if (binding) {
    const account = data.accounts.find(account => account.id === binding.accountId);
    const quotaBlockedAlias = account?.identityId && data.accounts.find(other => other.id !== account.id
      && other.identityId === account.identityId && (other.blockedUntil > now || other.cooldownUntil > now
        || availability(other.usage, model, now) === 'exhausted'));
    const reason = accountUnavailableReason(account, binding, usage => availability(usage, model, now), now)
      || (quotaBlockedAlias && accountUnavailableReason(quotaBlockedAlias, null, usage => availability(usage, model, now), now));
    if (!reason && !isExcluded(account)) return { account, reason: binding.reason };
    if (!data.autoSwitch) throw new Error(`${reason || '当前账号不可用'}；自动切换已关闭。`);
    previous = binding.accountId;
    excluded.add(binding.accountId);
  }
  if (!binding && !data.balanceSessions) {
    const account = data.accounts.find(account => account.id === data.activeId);
    if (!data.autoSwitch || (!isExcluded(account) && !accountUnavailableReason(account, null,
      usage => availability(usage, model, now), now))) return { account, reason: 'selected_default' };
  }
  const candidates = [];
  const identities = new Set();
  for (const account of data.accounts) {
    if (isExcluded(account) || account.account?.type !== 'chatgpt' || accountUnavailableReason(account, null,
      usage => availability(usage, model, now), now)) continue;
    const identity = account.identityId || account.id;
    if (identities.has(identity)) continue;
    identities.add(identity);
    const aliases = data.accounts.filter(other => (other.identityId || other.id) === identity);
    if (aliases.some(other => other.blockedUntil > now || other.cooldownUntil > now
      || availability(other.usage, model, now) === 'exhausted')) continue;
    const owners = (await Promise.all(aliases.map(other => pool.registeredRuns(other)))).flat();
    const activeSessions = new Set(owners.filter(owner => owner.sessionId).map(owner => owner.sessionId));
    for (const [id, pending] of Object.entries(data.pendingSessions || {})) {
      if (pending.expiresAt > now && aliases.some(alias => alias.id === pending.accountId)) activeSessions.add(id);
    }
    const load = activeSessions.size + owners.filter(owner => !owner.sessionId).length;
    candidates.push({ account, load, unknown: availability(account.usage, model, now) === 'unknown' ? 1 : 0 });
  }
  candidates.sort((a, b) => a.load - b.load
    || (a.account.lastAssignedSequence || 0) - (b.account.lastAssignedSequence || 0)
    || a.unknown - b.unknown
    || a.account.id.localeCompare(b.account.id));
  if (!candidates.length) throw new Error('暂无可用的 Codex 账号，请等待限流或额度恢复，或完成账号登录。');
  return { account: candidates[0].account, reason: previous ? 'unavailable_account_failover' : 'least_busy_session',
    switched: !!previous, previousAccountId: previous };
}
