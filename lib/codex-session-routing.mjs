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
export async function chooseSessionAccount(pool, data, sessionId, model, availability) {
  const now = pool.now();
  const binding = await readSessionAccount(pool.root, sessionId);
  if (binding) {
    const account = data.accounts.find(account => account.id === binding.accountId);
    const reason = accountUnavailableReason(account, binding, usage => availability(usage, model, now), now);
    if (reason) throw new Error(`${reason}；本 Session 保持原账号，不自动切换。`);
    return { account, reason: binding.reason };
  }
  if (!data.balanceSessions) return { account: data.accounts.find(account => account.id === data.activeId), reason: 'selected_default' };
  const candidates = [];
  const identities = new Set();
  for (const account of data.accounts) {
    if (account.account?.type !== 'chatgpt' || accountUnavailableReason(account, null,
      usage => availability(usage, model, now), now)) continue;
    const identity = account.identityId || account.id;
    if (identities.has(identity)) continue;
    identities.add(identity);
    const aliases = data.accounts.filter(other => (other.identityId || other.id) === identity);
    if (aliases.some(other => other.blockedUntil > now || other.cooldownUntil > now
      || availability(other.usage, model, now) === 'exhausted')) continue;
    const load = (await Promise.all(aliases.map(other => pool.registeredRuns(other)))).reduce((n, runs) => n + runs.length, 0);
    candidates.push({ account, load, unknown: availability(account.usage, model, now) === 'unknown' ? 1 : 0 });
  }
  candidates.sort((a, b) => a.unknown - b.unknown || a.load - b.load
    || (a.account.lastAssignedSequence || 0) - (b.account.lastAssignedSequence || 0)
    || a.account.id.localeCompare(b.account.id));
  if (!candidates.length) throw new Error('暂无可用的 Codex 账号，请等待限流或额度恢复，或完成账号登录。任务尚未启动。');
  return { account: candidates[0].account, reason: 'least_busy_session' };
}
