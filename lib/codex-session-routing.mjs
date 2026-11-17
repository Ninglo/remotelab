import { readRunState } from './run-state.mjs';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRecord, writeDurableJson } from './durable-records.mjs';
import { isSharedCodexAccount } from './codex-account-ownership.mjs';

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
    const run = await readRunState(join(runsRoot, name));
    if (!run?.sessionId || !run.codexAccount?.id) continue;
    const previous = latest.get(run.sessionId);
    const stamp = run.codexAccount.selectedAt || run.startedAt || run.createdAt || '';
    if (!previous || stamp > previous.stamp) latest.set(run.sessionId, { stamp, id: run.codexAccount.id });
  }
  for (const [sessionId, { id }] of latest) {
    if (await readSessionAccount(root, sessionId)) continue;
    const account = data.accounts.find(account => account.id === id);
    if (isSharedCodexAccount(account)) await bindSessionAccount(root, sessionId, account, 'existing_session', now);
  }
}

export function isRoutingAccountEnabled(data, account) {
  return isSharedCodexAccount(account) && !account.removedAt && !account.credentialIssue
    && (data.disabledAccountIds != null ? !data.disabledAccountIds.includes(account.id)
      : data.routingAccountIds == null || data.routingAccountIds.includes(account.id));
}

export function accountUnavailableReason(account, binding, availability, now) {
  if (!account) return 'Session 绑定的 Codex 账号已不存在';
  if (account.credentialIssue) return account.credentialIssue;
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

// One shared allocator, called under the metadata lock. Policy switches and
// legacy scheduled reservations cannot shrink the enabled pool. Healthy Session
// affinity preserves native continuation; new assignments use least load + rotation.
export async function chooseSessionAccount(pool, data, sessionId, model, availability, excludedAccountIds = []) {
  const now = pool.now();
  const binding = sessionId ? await readSessionAccount(pool.root, sessionId) : null;
  const excluded = new Set(excludedAccountIds);
  const identity = account => account.identityId || account.id;
  const excludedIdentities = new Set(data.accounts.filter(a => excluded.has(a.id)).map(identity));
  const groups = new Map();
  for (const account of data.accounts.filter(isSharedCodexAccount)) {
    const key = identity(account);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(account);
  }
  const candidates = [], rejected = [];
  for (const aliases of groups.values()) {
    const enabled = aliases.filter(a => isRoutingAccountEnabled(data, a));
    const blocked = aliases.find(a => a.blockedUntil > now || a.cooldownUntil > now
      || availability(a.usage, model, now) === 'exhausted');
    const usable = enabled.filter(a => !accountUnavailableReason(a, a.id === binding?.accountId ? binding : null,
      usage => availability(usage, model, now), now));
    const account = usable.find(a => a.id === binding?.accountId) || usable[0];
    const reason = !enabled.length ? 'disabled_or_credentials'
      : excludedIdentities.has(identity(aliases[0])) ? 'attempted'
      : blocked ? (blocked.cooldownUntil > now ? 'rate_limited' : 'quota_exhausted')
      : !account ? (enabled.some(a => a.id === binding?.accountId && binding.identityId && a.identityId
        && binding.identityId !== a.identityId) ? 'identity_changed' : 'signed_out') : '';
    if (reason) { rejected.push({ reason, count: aliases.length }); continue; }
    const owners = (await Promise.all(aliases.map(a => pool.registeredRuns(a)))).flat();
    const sessions = new Set(owners.filter(o => o.sessionId).map(o => o.sessionId));
    for (const [id, pending] of Object.entries(data.pendingSessions || {})) {
      if (pending.expiresAt > now && aliases.some(a => a.id === pending.accountId)) sessions.add(id);
    }
    const bound = account.id === binding?.accountId && !accountUnavailableReason(account, binding,
      usage => availability(usage, model, now), now);
    candidates.push({ account, bound, sequence: Math.max(...aliases.map(a => a.lastAssignedSequence || 0)), load: sessions.size + owners.filter(o => !o.sessionId).length });
  }
  if (!candidates.length) {
    const counts = {};
    for (const { reason, count } of rejected) counts[reason] = (counts[reason] || 0) + count;
    const names = { disabled_or_credentials: '暂停分流或授权异常', attempted: '本次已尝试',
      rate_limited: '限流冷却', quota_exhausted: '额度耗尽', signed_out: '未登录', identity_changed: '登录身份已改变' };
    const detail = Object.entries(counts).map(([key, count]) => `${names[key]} ${count}`).join('；');
    const error = new Error(`暂无可用的 Codex 账号（${detail || '未配置公共账号'}）。请在设置 → 连接 → 公共 Codex 账号查看。`);
    error.code = 'CODEX_NO_AVAILABLE_ACCOUNT';
    error.routingReasons = counts;
    throw error;
  }
  candidates.sort((a, b) => a.load - b.load
    || a.sequence - b.sequence
    || a.account.id.localeCompare(b.account.id));
  const chosen = candidates.find(c => c.bound) || candidates[0];
  const previous = binding?.accountId;
  const switched = !!previous && previous !== chosen.account.id;
  return { account: chosen.account, reason: chosen.bound ? binding.reason
    : switched ? 'unavailable_account_failover' : 'least_busy_session', switched,
    migration: switched ? { from: previous, to: chosen.account.id, sessionId,
      at: new Date(now).toISOString(), reason: 'account_unavailable' } : null };
}
