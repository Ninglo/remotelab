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

export function validAccountAllocationSettings(account) {
  return (account.maxConcurrent == null || (Number.isSafeInteger(account.maxConcurrent) && account.maxConcurrent > 0))
    && (account.priority === undefined || (Number.isSafeInteger(account.priority) && account.priority >= 0));
}

export function sharedAccountAllocationSettings(aliases) {
  // Duplicate login entries share a subscription. Old/conflicting records may
  // not bypass a finite limit; administrator writes update all known aliases.
  const limits = aliases.map(a => a.maxConcurrent).filter(Number.isSafeInteger);
  return { maxConcurrent: limits.length ? Math.min(...limits) : null,
    priority: Math.min(...aliases.map(a => a.priority ?? 10)) };
}

export async function inspectSharedAccountAllocation(pool, data, model, availability, excludedAccountIds = [], binding = null) {
  const now = pool.now();
  const excluded = new Set(excludedAccountIds);
  const identity = account => account.identityId || account.id;
  const excludedIdentities = new Set(data.accounts.filter(a => excluded.has(a.id)).map(identity));
  const groups = new Map();
  for (const account of data.accounts.filter(isSharedCodexAccount)) {
    const key = identity(account);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(account);
  }
  const groupsState = [];
  for (const aliases of groups.values()) {
    const settings = sharedAccountAllocationSettings(aliases);
    const enabled = aliases.filter(a => isRoutingAccountEnabled(data, a));
    const exhausted = aliases.some(a => a.blockedUntil > now || availability(a.usage, model, now) === 'exhausted');
    const cooldownUntil = Math.max(0, ...aliases.map(a => a.cooldownUntil || 0));
    const usable = enabled.filter(a => !accountUnavailableReason(a, a.id === binding?.accountId ? binding : null,
      usage => availability(usage, model, now), now));
    const account = usable.find(a => a.id === binding?.accountId) || usable[0];
    let reason = !enabled.length ? 'disabled_or_credentials'
      : excludedIdentities.has(identity(aliases[0])) ? 'attempted'
      : exhausted ? 'quota_exhausted'
      : cooldownUntil > now ? 'rate_limited'
      : !account ? (enabled.some(a => a.id === binding?.accountId && binding.identityId && a.identityId
        && binding.identityId !== a.identityId) ? 'identity_changed' : 'signed_out') : '';
    const homes = [...new Map(aliases.map(a => [a.home, a])).values()];
    const owners = (await Promise.all(homes.map(a => pool.registeredRuns(a)))).flat();
    // Each independent execution counts, including helpers in the same Session.
    // An idle conversation or an already-finished helper holds no capacity.
    const load = owners.length;
    if (!reason && settings.maxConcurrent !== null && load >= settings.maxConcurrent) reason = 'at_capacity';
    const bound = !!account && account.id === binding?.accountId && !accountUnavailableReason(account, binding,
      usage => availability(usage, model, now), now);
    groupsState.push({ account, aliases, reason, bound, ...settings, load, cooldownUntil,
      sequence: Math.max(...aliases.map(a => a.lastAssignedSequence || 0)) });
  }
  return groupsState;
}

// Selection and registration run under the same short metadata lock. Priority
// wins over Session affinity; active work is never moved to rebalance traffic.
export async function chooseSessionAccount(pool, data, sessionId, model, availability, excludedAccountIds = []) {
  const now = pool.now();
  const binding = sessionId ? await readSessionAccount(pool.root, sessionId) : null;
  const groups = await inspectSharedAccountAllocation(pool, data, model, availability, excludedAccountIds, binding);
  const candidates = groups.filter(group => !group.reason);
  if (!candidates.length) {
    const counts = {};
    for (const { reason, aliases } of groups) counts[reason] = (counts[reason] || 0) + aliases.length;
    const names = { disabled_or_credentials: '暂停分流或授权异常', attempted: '本次已尝试',
      rate_limited: '限流冷却', at_capacity: '达到并发上限', quota_exhausted: '额度耗尽', signed_out: '未登录', identity_changed: '登录身份已改变' };
    const detail = Object.entries(counts).map(([key, count]) => `${names[key]} ${count}`).join('；');
    const error = new Error(`暂无可用的 Codex 账号（${detail || '未配置公共账号'}）。请在设置 → 连接 → 公共 Codex 账号查看。`);
    error.code = counts.at_capacity || counts.rate_limited ? 'CODEX_ACCOUNT_CAPACITY_WAIT' : 'CODEX_NO_AVAILABLE_ACCOUNT';
    error.retryAt = Math.min(...groups.filter(g => g.reason === 'rate_limited').map(g => g.cooldownUntil));
    error.routingReasons = counts;
    throw error;
  }
  candidates.sort((a, b) => a.priority - b.priority || Number(b.bound) - Number(a.bound) || a.load - b.load
    || a.sequence - b.sequence
    || a.account.id.localeCompare(b.account.id));
  const chosen = candidates[0];
  const previous = binding?.accountId;
  const switched = !!previous && previous !== chosen.account.id;
  const previousGroup = groups.find(g => g.aliases.some(a => a.id === previous));
  const reason = chosen.bound ? 'session_affinity' : switched && !previousGroup?.reason ? 'higher_priority_account'
    : switched && previousGroup?.reason === 'at_capacity' ? 'account_at_capacity'
    : switched ? 'unavailable_account_failover' : 'priority_then_load';
  return { account: chosen.account, reason, switched,
    allocation: { priority: chosen.priority, maxConcurrent: chosen.maxConcurrent, activeBefore: chosen.load },
    migration: switched ? { from: previous, to: chosen.account.id, sessionId,
      at: new Date(now).toISOString(), reason } : null };
}
