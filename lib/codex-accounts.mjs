import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rmdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { resolveCodexHomeDir, resolveMachineAccountHomeDir } from './codex-home.mjs';
import { readCodexAccountStatus, readCodexAuthMetadata, codexAccountRevision } from './codex-account-status.mjs';
import { readRecord, writeDurableJson } from './durable-records.mjs';
import { acquireProviderRuntimeLease } from '../chat/provider-runtime-queue.mjs';
import { acquireCodexRunSlot, readCodexRunSlots } from './codex-run-slots.mjs';
import { readNativeUsage } from '../chat/native-input-transport.mjs';
import { isRoutingAccountEnabled, accountUnavailableReason, chooseSessionAccount, bindSessionAccount, readSessionAccount, preserveExistingSessionAccounts,
  validAccountAllocationSettings, inspectSharedAccountAllocation } from './codex-session-routing.mjs';
import { acquireWithCodexCapacityWait, notifyCodexAllocation, readCodexAllocationWaiters } from './codex-allocation-wait.mjs';
import { isPersonalCodexAccount, isSharedCodexAccount, validCodexAccountOwnership,
  readCodexSubscriptionIdentity, codexOwnershipConflict } from './codex-account-ownership.mjs';

const freshMs = 60_000;
const reservePercent = 10;
const validId = id => id === 'default' || /^[0-9a-f-]{36}$/.test(id || '');
const digest = value => createHash('sha256').update(value).digest('hex');

// Unknown or an elapsed reset is never evidence of exhaustion or paid access.
export function subscriptionAvailability(usage, model = '', now = Date.now()) {
  const checkedAt = Date.parse(usage?.checkedAt || '');
  if (usage?.status !== 'ready' || !Number.isFinite(checkedAt) || now - checkedAt > freshMs
    || checkedAt > now + 5000) return 'unknown';
  const buckets = (usage.buckets || []).filter(bucket => bucket.id === 'codex'
    || bucket.id === model || bucket.name === model);
  const windows = buckets.flatMap(bucket => [bucket.primary, bucket.secondary]).filter(Boolean);
  if (!windows.length || windows.some(window => !Number.isFinite(window.remainingPercent)
    || window.remainingPercent < 0 || window.remainingPercent > 100)) return 'unknown';
  if (windows.some(window => window.remainingPercent <= 0
    && (!window.resetsAt || Date.parse(window.resetsAt) > now))) return 'exhausted';
  if (windows.some(window => window.resetsAt && Date.parse(window.resetsAt) <= now)) return 'unknown';
  return windows.every(window => window.remainingPercent > 0) ? 'available' : 'unknown';
}

export function isSubscriptionExhausted(error) {
  const message = String(error?.message || error || '');
  return /\busage_limit_reached\b|you(?:'|’)?ve hit your usage limit|subscription (?:usage |quota )?(?:limit (?:reached|exceeded)|exhausted)|weekly usage limit (?:reached|exceeded)/i.test(message);
}

export function classifyCodexAccountFailure(error) {
  const message = String(error?.message || error || '');
  if (isSubscriptionExhausted(message)) return 'quota_exhausted';
  if (/capacity limit|(?:model|engine)[^\n]*at capacity|at capacity[^\n]*(?:try again|different model)|insufficient capacity/i.test(message)) return 'capacity';
  if (/\b429\b|too many requests|\brate_limit(?:_exceeded)?\b/i.test(message)) return 'rate_limited';
  return null;
}

function remainingSubscriptionPercent(account, now) {
  if (subscriptionAvailability(account.usage, '', now) === 'unknown') return null;
  return Math.min(...account.usage.buckets.filter(bucket => bucket.id === 'codex')
    .flatMap(bucket => [bucket.primary, bucket.secondary]).filter(Boolean).map(window => window.remainingPercent));
}

// Only background samples and confirmed quota failures change the default.
// A running request keeps its authorization; the next request reads this default.
function updateDefaultAccount(data, now) {
  if (!data.autoSwitch) return;
  const active = data.accounts.find(account => account.id === data.activeId);
  const remaining = remainingSubscriptionPercent(active, now);
  if (isRoutingAccountEnabled(data, active) && !(active.blockedUntil > now) && (remaining === null || remaining > reservePercent)) return;
  const candidates = data.accounts.filter(account => isRoutingAccountEnabled(data, account) && account.id !== active.id
    && (!active.identityId || account.identityId !== active.identityId)
    && account.account?.type === 'chatgpt' && !(account.blockedUntil > now)
    && remainingSubscriptionPercent(account, now) > 0);
  const next = candidates.find(account => remainingSubscriptionPercent(account, now) > reservePercent)
    || ((active.blockedUntil > now || remaining === 0)
      ? candidates.sort((a, b) => remainingSubscriptionPercent(b, now) - remainingSubscriptionPercent(a, now))[0] : null);
  if (next) {
    data.lastSwitch = { from: active.id, to: next.id, at: new Date(now).toISOString(),
      reason: remainingSubscriptionPercent(next, now) <= reservePercent ? 'remaining_balance_fallback'
        : active.blockedUntil > now ? 'confirmed_exhaustion' : 'reserve', remainingPercent: remaining };
    data.switchEvents=[...(data.switchEvents||[]),{...data.lastSwitch,kind:'default'}].slice(-100);
    data.activeId = next.id;
  }
}

export class CodexAccounts {
  constructor({ root = join(CONFIG_DIR, 'codex-accounts'), defaultHome = resolveCodexHomeDir(),
    query = readCodexAccountStatus,
    queryLiveUsage = runId => readNativeUsage(join(root, '..', 'chat-runs', runId)), now = Date.now } = {}) {
    this.root = root; this.defaultHome = resolve(defaultHome); this.query = query; this.now = now;
    this.queryLiveUsage = queryLiveUsage;
    this.file = join(root, 'accounts.json');
  }
  async read() {
    const data = await readRecord(this.file);
    if (!data) return { version: 1, activeId: 'default', autoSwitch: false,
      accounts: [{ id: 'default', home: this.defaultHome, label: '', account: null, usage: null }] };
    if (data.version !== 1 || !Array.isArray(data.accounts) || !data.accounts.every(a => validId(a.id)
      && typeof a.home === 'string' && resolve(a.home) === a.home
      && (a.sqliteHome === undefined || (typeof a.sqliteHome === 'string' && resolve(a.sqliteHome) === a.sqliteHome))
      && validCodexAccountOwnership(a) && validAccountAllocationSettings(a)) || typeof data.autoSwitch !== 'boolean'
      || (data.routingAccountIds != null && (!Array.isArray(data.routingAccountIds)
        || !data.routingAccountIds.every(validId)))
      || (data.disabledAccountIds != null && (!Array.isArray(data.disabledAccountIds)
        || !data.disabledAccountIds.every(validId)))
      || new Set(data.accounts.map(a => a.id)).size !== data.accounts.length
      || !data.accounts.some(a => a.id === data.activeId && isSharedCodexAccount(a))
      || new Set(data.accounts.filter(isPersonalCodexAccount).map(a => a.ownerPersonId)).size
        !== data.accounts.filter(isPersonalCodexAccount).length) {
      throw new Error('Codex account list is invalid');
    }
    // Migrate the old allowlist once against the accounts that already exist.
    // New accounts are enabled by default; only explicit exceptions persist.
    data.disabledAccountIds ??= data.accounts.filter(a => isSharedCodexAccount(a)
      && data.routingAccountIds != null && !data.routingAccountIds.includes(a.id)).map(a => a.id);
    return data;
  }
  async mutate(update) {
    const lease = await acquireProviderRuntimeLease({ queueKey: 'metadata', rootDir: join(this.root, 'locks') });
    try {
      const data = await this.read(); const result = await update(data);
      data.disabledAccountIds ??= [];
      // Keep the legacy projection readable by detached runners from before an upgrade.
      data.routingAccountIds = data.disabledAccountIds.length || data.accounts.some(a => a.removedAt)
        ? data.accounts.filter(a => isSharedCodexAccount(a)
          && !a.removedAt && !data.disabledAccountIds.includes(a.id)).map(a => a.id) : null;
      await writeDurableJson(this.file, data); return result;
    } finally { await lease.release(); }
  }
  async account(id) {
    const data = await this.read(); const account = data.accounts.find(a => a.id === (id || data.activeId));
    if (!account) throw new Error('找不到已保存的 Codex 账号');
    return account;
  }
  async activeHome() { return (await this.account()).home; }
  async personalAccount(personId) {
    return (await this.read()).accounts.find(a => isPersonalCodexAccount(a) && a.ownerPersonId === personId) || null;
  }
  async executionPolicy(personId = '') {
    const account = personId ? await this.personalAccount(personId) : null;
    return { version: 1, personId, personalAccountId: account?.boundAt ? account.id : null };
  }
  async ensurePersonalAccount(personId) {
    if (!/^person_[a-zA-Z0-9_-]+$/.test(personId || '')) throw new Error('需要已核验的个人身份');
    const existing = await this.personalAccount(personId);
    if (existing) return existing;
    const id = randomUUID(), home = join(this.root, 'homes', id);
    await this.prepareHome(home);
    return this.mutate(data => {
      const concurrent = data.accounts.find(a => isPersonalCodexAccount(a) && a.ownerPersonId === personId);
      if (concurrent) return concurrent;
      const account = { id, home, sqliteHome: this.defaultHome, scope: 'personal', ownerPersonId: personId,
        label: '个人 Codex', account: null, usage: null, personalEnabled: false, boundAt: null };
      data.accounts.push(account);
      return account;
    });
  }
  async setPersonalEnabled(id, personId, enabled, { unbind = false } = {}) {
    await this.mutate(data => {
      const account = data.accounts.find(a => a.id === id && isPersonalCodexAccount(a) && a.ownerPersonId === personId);
      if (!account) throw new Error('找不到本人的 Codex 绑定');
      if (enabled && (!account.identityId || account.credentialIssue || !account.account)) throw new Error('请先完成个人账号授权');
      account.personalEnabled = enabled;
      if (enabled) account.boundAt = new Date(this.now()).toISOString();
      if (unbind) account.boundAt = null;
    });
  }
  async lease(account, options = {}) {
    const lease = await acquireProviderRuntimeLease({ queueKey: `account-${digest(account.home)}`,
      rootDir: join(this.root, 'locks'), ...options });
    try {
      if (lease && await this.inUse(account)) { await lease.release(); return null; }
      return lease;
    } catch (error) { await lease?.release(); throw error; }
  }
  async inUse(account) {
    return (await this.registeredRuns(account)).length > 0;
  }
  registeredRuns(account) {
    return readCodexRunSlots(this.root, account.home);
  }
  async prepareHome(home) {
    await mkdir(home, { recursive: true, mode: 0o700 });
    for (const name of ['sessions', 'archived_sessions', 'generated_images', 'shell_snapshots', 'thread-writer-locks']) {
      await mkdir(join(this.defaultHome, name), { recursive: true, mode: 0o700 });
    }
    // Share instructions and local threads; each authorization remains independent.
    for (const name of ['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'skills', 'plugins', 'rules',
      'memories', 'sessions', 'archived_sessions', 'generated_images', 'shell_snapshots', 'thread-writer-locks']) {
      const target = join(this.defaultHome, name);
      try { await lstat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const destination = join(home, name);
      if (resolve(home) === this.defaultHome) continue;
      try {
        const existing = await lstat(destination);
        if (existing.isDirectory() && !(await readdir(destination)).length) await rmdir(destination);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await symlink(target, destination); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  async add(label = '') {
    if (typeof label !== 'string' || label.length > 80) throw new Error('账号名称最多 80 字');
    const id = randomUUID(); const home = join(this.root, 'homes', id);
    await this.prepareHome(home);
    await this.mutate(data => {
      if (data.accounts.filter(a => !a.removedAt).length >= 100) throw new Error('最多保存 100 个账号');
      data.accounts.push({ id, home, sqliteHome: this.defaultHome, label: label.trim(), account: null, usage: null });
    });
    return this.account(id);
  }
  // Local operator-only adoption keeps the current refreshed cache in place.
  // The HTTP API never accepts a filesystem path or credential material.
  async adopt(home, label = '') {
    home = resolve(home); await lstat(join(home, 'auth.json'));
    await this.prepareHome(home);
    return this.mutate(data => {
      const existing = data.accounts.find(a => a.home === home && !a.removedAt);
      if (existing) return existing.id;
      if (data.accounts.filter(a => !a.removedAt).length >= 100) throw new Error('最多保存 100 个账号');
      const id = randomUUID(); data.accounts.push({ id, home, label, account: null, usage: null }); return id;
    });
  }
  async select(id) {
    if (!validId(id)) throw new Error('无效的账号编号');
    const account = await this.account(id);
    if (!account.account) throw new Error('请先完成这个账号的登录');
    await this.mutate(data => {
      if (!isRoutingAccountEnabled(data, account)) throw new Error('这个 Codex 账号已暂停分流');
      data.activeId = id;
    });
    return this.list();
  }
  async policy(autoSwitch, balanceSessions, routingAccountIds) {
    if ((autoSwitch !== undefined && typeof autoSwitch !== 'boolean')
      || (balanceSessions !== undefined && typeof balanceSessions !== 'boolean')
      || (autoSwitch === undefined && balanceSessions === undefined && routingAccountIds === undefined)) throw new Error('账号策略必须为布尔值');
    if (routingAccountIds !== undefined && routingAccountIds !== null
      && (!Array.isArray(routingAccountIds) || !routingAccountIds.every(validId))) {
      throw new Error('分流账号必须为账号编号数组或 null');
    }
    await this.mutate(async data => {
      if (routingAccountIds != null && routingAccountIds.some(id => !data.accounts.some(a => a.id === id && isSharedCodexAccount(a) && !a.removedAt))) {
        throw new Error('分流账号不存在');
      }
      if (routingAccountIds !== undefined) {
        data.disabledAccountIds = routingAccountIds === null ? [] : data.accounts
          .filter(a => isSharedCodexAccount(a) && !routingAccountIds.includes(a.id)).map(a => a.id);
        data.routingAccountIds = routingAccountIds === null ? null : [...new Set(routingAccountIds)];
        if (data.routingAccountIds?.length && !data.routingAccountIds.includes(data.activeId)) {
          data.activeId = data.routingAccountIds[0];
        }
      }
      if (balanceSessions === true && !data.balanceSessions) {
        await preserveExistingSessionAccounts(this.root, data, this.now());
      }
      if (autoSwitch !== undefined) data.autoSwitch = autoSwitch;
      if (balanceSessions !== undefined) data.balanceSessions = balanceSessions;
      updateDefaultAccount(data, this.now());
    }); return this.list();
  }
  async setRoutingEnabled(id, enabled) {
    return this.setRoutingSettings(id, { enabled });
  }
  async setRoutingSettings(id, patch) {
    const { enabled, maxConcurrent, priority } = patch;
    if (!validId(id) || !Object.keys(patch).some(key => ['enabled', 'maxConcurrent', 'priority'].includes(key))
      || (Object.hasOwn(patch, 'enabled') && typeof enabled !== 'boolean')
      || (Object.hasOwn(patch, 'maxConcurrent') && maxConcurrent !== null
        && (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1))
      || (Object.hasOwn(patch, 'priority') && (!Number.isSafeInteger(priority) || priority < 0))) {
      throw new Error('并发上限须为正整数或不限，优先级须为非负整数');
    }
    await this.mutate(data => {
      const account = data.accounts.find(account => account.id === id && isSharedCodexAccount(account) && !account.removedAt);
      if (!account) throw new Error('分流账号不存在');
      // Apply one administrator's choice to the latest list under the metadata
      // lock; a stale browser must not overwrite changes to other accounts.
      const disabled = new Set(data.disabledAccountIds || []);
      if (enabled === true) disabled.delete(id); else if (enabled === false) disabled.add(id);
      data.disabledAccountIds = [...disabled];
      for (const alias of data.accounts.filter(isSharedCodexAccount)) {
        if (alias.id !== id && (!account.identityId || alias.identityId !== account.identityId)) continue;
        if (Object.hasOwn(patch, 'maxConcurrent')) alias.maxConcurrent = maxConcurrent;
        if (Object.hasOwn(patch, 'priority')) alias.priority = priority;
      }
      const next = data.accounts.find(account => isRoutingAccountEnabled(data, account));
      if (next && !isRoutingAccountEnabled(data, data.accounts.find(a => a.id === data.activeId))) data.activeId = next.id;
      updateDefaultAccount(data, this.now());
    });
    return this.list();
  }
  async remove(id) {
    if (!validId(id)) throw new Error('无效的账号编号');
    await this.mutate(data => {
      const account = data.accounts.find(a => a.id === id && isSharedCodexAccount(a));
      if (!account) throw new Error('找不到公共 Codex 账号');
      // Preserve running authorizations and historical Session bindings.
      account.removedAt ||= new Date(this.now()).toISOString();
      data.disabledAccountIds = [...new Set([...(data.disabledAccountIds || []), id])];
      if (data.activeId === id) {
        const next = data.accounts.find(a => isRoutingAccountEnabled(data, a))
          || data.accounts.find(a => isSharedCodexAccount(a) && !a.removedAt);
        if (next) data.activeId = next.id;
      }
      updateDefaultAccount(data, this.now());
    });
    return this.list();
  }
  async inspect(account, command, lease = null, { maxAgeMs = 0, includeRateLimits = true } = {}) {
    const owned = lease || await acquireProviderRuntimeLease({
      queueKey: 'account-' + digest(account.home), rootDir: join(this.root, 'locks'), wait: false });
    if (!owned) return account;
    try {
      account = await this.account(account.id);
      if (account.removedAt) return account;
      const age = this.now() - Date.parse(account.usage?.checkedAt || '');
      const resetAge = this.now() - Date.parse(account.usage?.resetCreditsCheckedAt || '');
      if (maxAgeMs > 0 && age >= 0 && age < maxAgeMs && resetAge >= 0 && resetAge < maxAgeMs) return account;
      const running = await this.registeredRuns(account);
      if (running.length) {
        // Reuse one active App Server instead of opening another credential
        // reader. Other collectors skip this nonblocking account control lease.
        for (const owner of running) {
          if (!/^run_[a-f0-9]{24}$/.test(owner.runId || '')) continue;
          let usage;
          try {
            usage = await this.queryLiveUsage(owner.runId);
          } catch (error) {
            // Try another runner only if this one has no endpoint. A slow
            // provider read must not fan out to every parallel model process.
            if (error.code === 'NATIVE_UNAVAILABLE') continue;
            return account;
          }
          if (usage?.status !== 'ready') return account;
          await this.observeUsage(account.id, { ...usage, resetCredits: usage.resetCredits ?? null });
          return this.account(account.id);
        }
        return account;
      }
      const queryOptions = { command, env: { ...process.env,
        HOME: resolveMachineAccountHomeDir(), CODEX_HOME: account.home,
        CODEX_SQLITE_HOME: account.sqliteHome || account.home }, includeRateLimits,
        onProcess: child => owned.setToolProcessId(child.pid),
        credentialStore: account.id === 'default' ? undefined : 'file' };
      let result;
      try { result = await this.query(queryOptions); }
      catch (error) {
        if (error.message !== 'Codex account changed; check status again') throw error;
        // Codex may have refreshed this owned cache. Read its new revision once,
        // without restoring an older token or repeating a model request.
        result = await this.query(queryOptions);
      }
      const usage = { status: 'unavailable', buckets: [], ...result.usage,
        resetCreditsCheckedAt: includeRateLimits ? result.checkedAt : null,
        checkedAt: result.checkedAt, accountRevision: result.accountRevision };
      const identity = await readCodexSubscriptionIdentity(account.home);
      const issue = await this.mutate(async data => {
        const entry = data.accounts.find(a => a.id === account.id);
        let credentialIssue = '';
        if (isPersonalCodexAccount(entry) && result.account && !identity.identityId) {
          credentialIssue = '无法核验 Codex 登录身份，请使用 ChatGPT 账号重新授权';
        }
        if (identity.identityId) for (const other of data.accounts) {
          if (other.id === entry.id || !(isPersonalCodexAccount(entry) || isPersonalCodexAccount(other))) continue;
          // Cover legacy accounts not yet inspected, and logged-out ownership
          // tombstones. A second login cannot bypass exclusivity.
          const known = other.subjectId || isPersonalCodexAccount(other) || other.credentialIssue
            ? other : { ...other, ...await readCodexSubscriptionIdentity(other.home) };
          if (codexOwnershipConflict(entry, identity, other, known)) {
            credentialIssue = '这个 Codex 账号已绑定到公共池或其他用户，请使用另一个账号'; break;
          }
        }
        Object.assign(entry, { account: credentialIssue ? null : result.account, usage,
          ...(!credentialIssue && identity.identityId ? identity : {}), checkedAt: result.checkedAt, credentialIssue });
        if (subscriptionAvailability(usage, '', this.now()) === 'available') delete entry.blockedUntil;
        updateDefaultAccount(data, this.now());
        return credentialIssue;
      });
      if (issue) throw new Error(issue);
      return this.account(account.id);
    } finally { if (!lease) await owned.release(); }
  }
  async refresh(id, command, options = {}) {
    const account = await this.account(id);
    try { return await this.inspect(account, command, null, options); }
    catch {
      await this.mutate(data => {
        const entry = data.accounts.find(a => a.id === account.id);
        entry.usage = { status: 'unavailable', buckets: [], checkedAt: new Date(this.now()).toISOString() };
      });
      return this.account(account.id);
    }
  }
  async observeUsage(id, usage, { checkedAt = new Date(this.now()).toISOString() } = {}) {
    return this.observeUsages([{ id, usage, checkedAt }]);
  }
  async observeUsages(samples) {
    const current = await this.read();
    const revisions = new Map(await Promise.all([...new Set(samples.map(sample => sample.id))].map(async id => {
      const entry = current.accounts.find(account => account.id === id);
      return [id, entry ? (await readCodexAuthMetadata(entry.home)).revision : null];
    })));
    await this.mutate(data => {
      for (const { id, usage, checkedAt } of samples) {
        const account = data.accounts.find(a => a.id === id);
        const stamp = Date.parse(checkedAt || '');
        if (!account || !Number.isFinite(stamp) || stamp > this.now() + 5000
          || stamp < Date.parse(account.usage?.checkedAt || '')) continue;
        const accountRevision = codexAccountRevision(revisions.get(id), account.account);
        // Native quota-only notifications must neither erase reset inventory
        // nor refresh its age. Full reads separately advance that timestamp.
        const reset = Object.hasOwn(usage, 'resetCredits')
          ? { resetCredits: usage.resetCredits, resetCreditsCheckedAt: checkedAt }
          : account.usage?.accountRevision === accountRevision
            ? { resetCredits: account.usage.resetCredits, resetCreditsCheckedAt: account.usage.resetCreditsCheckedAt } : {};
        account.usage = { ...usage, ...reset, checkedAt, accountRevision };
        account.checkedAt = checkedAt;
        if (subscriptionAvailability(account.usage, '', this.now()) === 'available') delete account.blockedUntil;
        // Preserve a reserve crossing even when another sample is in the batch.
        updateDefaultAccount(data, this.now());
      }
    });
  }
  async list({ refresh = false, command, includePersonal = false } = {}) {
    if (refresh && command) {
      await Promise.all((await this.read()).accounts.filter(a => !a.removedAt && (includePersonal || isSharedCodexAccount(a))).map(account =>
        this.refresh(account.id, command, { maxAgeMs: refresh === 'stale' ? freshMs / 2 : 0 })));
    }
    const data = await this.read();
    const groups = await inspectSharedAccountAllocation(this, data, '', subscriptionAvailability);
    const allocation = new Map(groups.flatMap(group => group.aliases.map(a => [a.id, {
      maxConcurrent: group.maxConcurrent, priority: group.priority, activeExecutions: group.load,
      routingState: group.reason || 'ready',
    }])));
    const waitingCount = (await readCodexAllocationWaiters(this.root)).length;
    return { activeId: data.activeId, autoSwitch: data.autoSwitch, balanceSessions: true,
      waitingCount,
      automationRouting: null,
      routingAccountIds: data.routingAccountIds ?? null,
      disabledAccountIds: data.disabledAccountIds || [],
      accounts: data.accounts.filter(a => !a.removedAt && (includePersonal || isSharedCodexAccount(a))).map(({ id, label, account, usage, checkedAt, identityId, scope, ownerPersonId, credentialIssue, cooldownUntil, blockedUntil, lastFailure }) => ({
        id, label: label || account?.name || account?.email || 'Codex', account, identityId,
        ...allocation.get(id),
        cooldownUntil: cooldownUntil || null, blockedUntil: blockedUntil || null, lastFailure: lastFailure || null,
        scope: scope || 'shared', ...(includePersonal && ownerPersonId ? { ownerPersonId } : {}),
        usage, checkedAt: checkedAt || null, active: id === data.activeId, credentialIssue: credentialIssue || '',
        routingEnabled: isRoutingAccountEnabled(data, { id, scope, ownerPersonId, credentialIssue }),
        availability: subscriptionAvailability(usage, '', this.now()),
      })) };
  }
  async markExhausted(id, model = '', { checkedAt = new Date(this.now()).toISOString() } = {}) {
    const stamp = Date.parse(checkedAt);
    if (!Number.isFinite(stamp) || this.now() - stamp > freshMs || stamp > this.now() + 5000) return;
    await this.mutate(data => {
      const entry = data.accounts.find(a => a.id === id);
      if (!entry) return;
      const resets = (entry.usage?.buckets || []).filter(b => b.id === 'codex' || b.id === model)
        .flatMap(b => [b.primary, b.secondary]).filter(Boolean)
        .filter(w => w.remainingPercent <= 0).map(w => Date.parse(w.resetsAt)).filter(t => t > this.now());
      entry.lastFailure = { kind: 'quota_exhausted', model, at: checkedAt };
      entry.blockedUntil = resets.length ? Math.max(...resets) : stamp + freshMs;
      updateDefaultAccount(data, this.now());
    });
  }
  async markRateLimited(id, { checkedAt = new Date(this.now()).toISOString(), kind = 'rate_limited', model = '' } = {}) {
    const stamp = Date.parse(checkedAt);
    if (!Number.isFinite(stamp) || this.now() - stamp > freshMs || stamp > this.now() + 5000) return;
    await this.mutate(data => {
      const account = data.accounts.find(account => account.id === id);
      if (account) for (const alias of data.accounts) {
        if (alias.id === id || (account.identityId && alias.identityId === account.identityId)) {
          alias.lastFailure = { kind: kind === 'capacity' ? 'capacity' : 'rate_limited', model, at: checkedAt };
          alias.cooldownUntil = Math.max(alias.cooldownUntil || 0, stamp + 60_000);
        }
      }
    });
  }
  async acquireForRun(options = {}) {
    return acquireWithCodexCapacityWait(this, options, () => this.tryAcquireForRun(options));
  }
  async tryAcquireForRun({ isCancelled = () => false, runId = '', sessionId = '', model = '', resumeThreadId = '', excludedAccountIds = [], confirmedExhaustedAccountIds = [], scheduleId = '', accountPolicy = null } = {}) {
    let personalFallback = null;
    if (accountPolicy?.personalAccountId) {
      let personalSlot;
      try {
        await this.mutate(async data => {
          const account = data.accounts.find(a => a.id === accountPolicy.personalAccountId
            && isPersonalCodexAccount(a) && a.ownerPersonId === accountPolicy.personId);
          if (!account?.boundAt || !account.personalEnabled) throw new Error('个人 Codex 绑定已变更或正在重新授权，请完成授权后重试');
          const unavailable = accountUnavailableReason(account, null, usage => subscriptionAvailability(usage, model, this.now()), this.now());
          const exhausted = confirmedExhaustedAccountIds.includes(account.id) || account.blockedUntil > this.now()
            || subscriptionAvailability(account.usage, model, this.now()) === 'exhausted';
          if (exhausted && !account.credentialIssue && account.account && account.usage?.status !== 'signed_out') {
            personalFallback = { reason: 'personal_quota_exhausted', personalAccountId: account.id, personId: accountPolicy.personId };
            return;
          }
          if (unavailable || excludedAccountIds.includes(account.id)) throw new Error(unavailable || '个人 Codex 账号本次执行不可用，请稍后重试');
          personalSlot = await this.registerRun(account, data, { isCancelled, runId, sessionId });
          personalSlot.assignmentReason = 'personal_account';
          personalSlot.autoSwitch = true; // Only exhaustion may cross into shared scope below.
        });
      } catch (error) { await personalSlot?.lease.release(); throw error; }
      if (personalSlot) return personalSlot;
    }
    let slot;
    try {
      await this.mutate(async data => {
        // Capacity belongs to live execution leases, never completed helpers.
        data.pendingSessions = {};
        // Cover a legacy runner that selected an account just as the policy was
        // enabled, before its status reached the migration snapshot.
        if (resumeThreadId && !await readSessionAccount(this.root, sessionId)) {
          await preserveExistingSessionAccounts(this.root, data, this.now());
        }
        const { account, reason, switched = false, migration, allocation } = await chooseSessionAccount(this, data, sessionId, model, subscriptionAvailability, excludedAccountIds);
        slot = await this.registerRun(account, data, { isCancelled, runId, sessionId });
        if (sessionId && (switched || (!await readSessionAccount(this.root, sessionId)))) {
          await bindSessionAccount(this.root, sessionId, account, reason, this.now());
          data.assignmentSequence = (data.assignmentSequence || 0) + 1;
          account.lastAssignedSequence = data.assignmentSequence;
        }
        if (!sessionId) {
          data.assignmentSequence = (data.assignmentSequence || 0) + 1;
          account.lastAssignedSequence = data.assignmentSequence;
        }
        if(migration)data.switchEvents=[...(data.switchEvents||[]),{...migration,kind:'session'}].slice(-100);
        if (runId) delete data.pendingSessions[sessionId];
        slot.assignmentReason = reason;
        slot.allocation = allocation;
        slot.switched = switched;
      });
      return { ...slot, personalFallback };
    } catch (error) { await slot?.lease.release(); throw error; }
  }
  async registerRun(account, data, { isCancelled, runId, sessionId }) {
    // Each request has its own liveness record, never a shared execution lock.
    // Login/logout and idle monitoring can check it without serializing work.
    const lease = await acquireCodexRunSlot(this.root, account.home, { runId, sessionId, isCancelled });
    const release = lease.release;
    lease.release = async () => {
      if (!await release()) return false;
      // Notification is an optimization; bounded liveness observation still
      // releases waiters if the process dies or this notification cannot write.
      await notifyCodexAllocation(this.root).catch(() => {});
      return true;
    };
    return { id: account.id, home: account.home, sqliteHome: account.sqliteHome || account.home,
      label: account.label || account.account?.name || 'Codex',
      scope: account.scope || 'shared', ownerPersonId: account.ownerPersonId || null,
      autoSwitch: data.autoSwitch, switched: false, lease };
  }
}

export const codexAccounts = new CodexAccounts();
