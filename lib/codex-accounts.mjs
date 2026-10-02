import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rmdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { resolveCodexHomeDir, resolveMachineAccountHomeDir } from './codex-home.mjs';
import { readCodexAccountStatus, readCodexAuthMetadata, codexAccountRevision } from './codex-account-status.mjs';
import { readRecord, writeDurableJson } from './durable-records.mjs';
import { acquireProviderRuntimeLease } from '../chat/provider-runtime-queue.mjs';
import { waitForCodexAccountChange } from './codex-account-wait.mjs';

const freshMs = 60_000;
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

export class CodexAccounts {
  constructor({ root = join(CONFIG_DIR, 'codex-accounts'), defaultHome = resolveCodexHomeDir(),
    query = readCodexAccountStatus, now = Date.now } = {}) {
    this.root = root; this.defaultHome = resolve(defaultHome); this.query = query; this.now = now;
    this.file = join(root, 'accounts.json');
  }
  async read() {
    const data = await readRecord(this.file);
    if (!data) return { version: 1, activeId: 'default', autoSwitch: false,
      accounts: [{ id: 'default', home: this.defaultHome, label: '', account: null, usage: null }] };
    if (data.version !== 1 || !Array.isArray(data.accounts) || !data.accounts.every(a => validId(a.id)
      && typeof a.home === 'string' && resolve(a.home) === a.home) || typeof data.autoSwitch !== 'boolean'
      || new Set(data.accounts.map(a => a.id)).size !== data.accounts.length
      || !data.accounts.some(a => a.id === data.activeId)) {
      throw new Error('Codex account list is invalid');
    }
    return data;
  }
  async mutate(update) {
    const lease = await acquireProviderRuntimeLease({ queueKey: 'metadata', rootDir: join(this.root, 'locks') });
    try {
      const data = await this.read(); const result = await update(data);
      await writeDurableJson(this.file, data); return result;
    } finally { await lease.release(); }
  }
  async account(id) {
    const data = await this.read(); const account = data.accounts.find(a => a.id === (id || data.activeId));
    if (!account) throw new Error('找不到已保存的 Codex 账号');
    return account;
  }
  async activeHome() { return (await this.account()).home; }
  async lease(account, options = {}) {
    return acquireProviderRuntimeLease({ queueKey: `account-${digest(account.home)}`,
      rootDir: join(this.root, 'locks'), ...options });
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
      if (data.accounts.length >= 100) throw new Error('最多保存 100 个账号');
      data.accounts.push({ id, home, label: label.trim(), account: null, usage: null });
    });
    return this.account(id);
  }
  // Local operator-only adoption keeps the current refreshed cache in place.
  // The HTTP API never accepts a filesystem path or credential material.
  async adopt(home, label = '') {
    home = resolve(home); await lstat(join(home, 'auth.json'));
    await this.prepareHome(home);
    return this.mutate(data => {
      const existing = data.accounts.find(a => a.home === home);
      if (existing) return existing.id;
      if (data.accounts.length >= 100) throw new Error('最多保存 100 个账号');
      const id = randomUUID(); data.accounts.push({ id, home, label, account: null, usage: null }); return id;
    });
  }
  async select(id) {
    if (!validId(id)) throw new Error('无效的账号编号');
    const account = await this.account(id);
    if (!account.account) throw new Error('请先完成这个账号的登录');
    await this.mutate(data => { data.activeId = id; });
    return this.list();
  }
  async policy(autoSwitch) {
    if (typeof autoSwitch !== 'boolean') throw new Error('自动切换必须为 true 或 false');
    await this.mutate(data => { data.autoSwitch = autoSwitch; }); return this.list();
  }
  async inspect(account, command, lease = null) {
    const owned = lease || await this.lease(account, { wait: false });
    if (!owned) return account;
    try {
      const queryOptions = { command, env: { ...process.env,
        HOME: resolveMachineAccountHomeDir(), CODEX_HOME: account.home }, includeRateLimits: true,
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
      const usage = { ...result.usage, checkedAt: result.checkedAt, accountRevision: result.accountRevision };
      let identityId = '';
      try {
        const auth = JSON.parse(await readFile(join(account.home, 'auth.json'), 'utf8'));
        const claims = JSON.parse(Buffer.from(auth.tokens?.id_token?.split('.')[1] || '', 'base64url'));
        const workspace = auth.tokens?.account_id || claims['https://api.openai.com/auth']?.chatgpt_account_id;
        if (claims.sub && workspace) identityId = digest(`${claims.sub}:${workspace}`);
      } catch { /* API-key and signed-out accounts do not have a subscription identity. */ }
      await this.mutate(data => {
        const entry = data.accounts.find(a => a.id === account.id);
        Object.assign(entry, { account: result.account, usage, identityId, checkedAt: result.checkedAt });
        if (subscriptionAvailability(usage, '', this.now()) === 'available') delete entry.blockedUntil;
      });
      return this.account(account.id);
    } finally { if (!lease) await owned.release(); }
  }
  async refresh(id, command) {
    const account = await this.account(id);
    try { return await this.inspect(account, command); }
    catch {
      await this.mutate(data => {
        const entry = data.accounts.find(a => a.id === account.id);
        entry.usage = { status: 'unavailable', buckets: [], checkedAt: new Date(this.now()).toISOString() };
      });
      return this.account(account.id);
    }
  }
  async observeUsage(id, usage) {
    const entry = await this.account(id);
    const metadata = await readCodexAuthMetadata(entry.home);
    await this.mutate(data => {
      const account = data.accounts.find(a => a.id === id);
      if (!account) return;
      const checkedAt = new Date(this.now()).toISOString();
      account.usage = { ...usage, checkedAt, accountRevision: codexAccountRevision(metadata.revision, account.account) };
      account.checkedAt = checkedAt;
    });
  }
  async list({ refresh = false, command } = {}) {
    if (refresh && command) for (const account of (await this.read()).accounts) await this.refresh(account.id, command);
    const data = await this.read();
    return { activeId: data.activeId, autoSwitch: data.autoSwitch,
      accounts: data.accounts.map(({ id, label, account, usage, checkedAt, identityId }) => ({
        id, label: label || account?.name || account?.email || 'Codex', account, identityId,
        usage, checkedAt: checkedAt || null, active: id === data.activeId,
        availability: subscriptionAvailability(usage, '', this.now()),
      })) };
  }
  async markExhausted(id, model = '') {
    await this.mutate(data => {
      const entry = data.accounts.find(a => a.id === id);
      const resets = (entry.usage?.buckets || []).filter(b => b.id === 'codex' || b.id === model)
        .flatMap(b => [b.primary, b.secondary]).filter(Boolean)
        .filter(w => w.remainingPercent <= 0).map(w => Date.parse(w.resetsAt)).filter(t => t > this.now());
      entry.blockedUntil = resets.length ? Math.max(...resets) : this.now() + freshMs;
    });
  }
  async acquireForRun({ command, model = '', exclude = [], isCancelled = () => false, runId = '', onWait = null } = {}) {
    let waitNotified = false;
    while (true) {
      if (await isCancelled()) {
        throw Object.assign(new Error('Codex account wait cancelled'), { code: 'PROVIDER_RUNTIME_QUEUE_CANCELLED' });
      }
      const data = await this.read();
      const ordered = [data.accounts.find(a => a.id === data.activeId), ...data.accounts.filter(a => a.id !== data.activeId)];
      const excludedIdentities = new Set(data.accounts.filter(a => exclude.includes(a.id)).map(a => a.identityId).filter(Boolean));
      const busy = [];
      for (const candidate of ordered) {
        if (exclude.includes(candidate.id) || excludedIdentities.has(candidate.identityId)
          || (data.autoSwitch && candidate.blockedUntil > this.now())) continue;
        if (!data.autoSwitch && candidate.id !== data.activeId) break;
        const lease = await this.lease(candidate, { isCancelled, runId, wait: !data.autoSwitch });
        if (!lease) { busy.push(candidate); continue; }
        try {
          let account = await this.account(candidate.id);
          if (data.autoSwitch) {
            try { account = await this.inspect(account, command, lease); }
            catch {
              account = { ...account, usage: { status: 'unavailable', buckets: [], checkedAt: new Date(this.now()).toISOString() } };
              await this.mutate(data => { data.accounts.find(a => a.id === account.id).usage = account.usage; });
            }
          }
          const availability = subscriptionAvailability(account.usage, model, this.now());
          if (account.identityId && excludedIdentities.has(account.identityId)) { await lease.release(); continue; }
          if (data.autoSwitch && (availability === 'exhausted' || !account.account
            || account.account.type !== 'chatgpt' || (candidate.id !== data.activeId && availability !== 'available'))) {
            if (account.identityId) excludedIdentities.add(account.identityId);
            await lease.release(); continue;
          }
          if (candidate.id !== data.activeId) await this.select(candidate.id);
          return { id: account.id, home: account.home, label: account.label || account.account?.name || 'Codex',
            autoSwitch: data.autoSwitch, switched: candidate.id !== data.activeId, lease };
        } catch (error) { await lease.release(); throw error; }
      }
      if (busy.length) {
        if (!waitNotified) {
          waitNotified = true;
          await onWait?.();
        }
        await waitForCodexAccountChange(busy.map(account =>
          join(this.root, 'locks', `account-${digest(account.home)}`)), this.root);
        continue;
      }
      throw Object.assign(new Error('暂时没有确认可用的订阅账号，请检查额度、添加账号或等待额度恢复。'), { code: 'CODEX_ACCOUNTS_EXHAUSTED' });
    }
  }
}

export const codexAccounts = new CodexAccounts();
