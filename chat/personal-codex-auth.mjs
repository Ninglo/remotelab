import { codexAccounts } from '../lib/codex-accounts.mjs';
import { PERSONAL_CODEX_FALLBACK } from '../lib/codex-account-ownership.mjs';
import { readCodexAuthMetadata } from '../lib/codex-account-status.mjs';
import { resolveToolCommandPathAsync } from '../lib/tools.mjs';
import { createCodexAuthManager } from './codex-auth.mjs';
import { createKeyedTaskQueue } from './fs-utils.mjs';

// Each verified Person owns an independent login process and credential home.
// Public account selection and the public login manager are never involved.
export function createPersonalCodexAuthManager({ pool = codexAccounts,
  createManager = createCodexAuthManager,
  resolveCommand = () => resolveToolCommandPathAsync('codex'), now = Date.now } = {}) {
  const jobs = new Map(), failures = new Map(), serial = createKeyedTaskQueue();
  const decorate = status => ({ fallbackPolicy: PERSONAL_CODEX_FALLBACK, ...status });
  async function release(personId, { stop = false } = {}) {
    const job = jobs.get(personId);
    if (!job) return;
    clearTimeout(job.timer);
    try { if (stop) await job.manager.stopActiveLogin(); }
    finally { jobs.delete(personId); await job.lease.release(); }
  }
  async function status(personId, { refresh = false } = {}) {
    const job = jobs.get(personId);
    if (job) {
      try {
        const state = await job.manager.getStatus();
        if (state.loggedIn) {
          await pool.inspect(await pool.account(job.id), await resolveCommand(), job.lease);
          await pool.setPersonalEnabled(job.id, personId, true);
          failures.delete(personId);
          await release(personId);
        } else if (state.deviceLoginActive) return decorate(state);
        else {
          failures.set(personId, state.error || '授权未完成，请重新绑定');
          await release(personId, { stop: true });
        }
      } catch (error) {
        failures.set(personId, error.message || '个人 Codex 授权失败');
        await release(personId, { stop: true });
      }
    }
    let account = await pool.personalAccount(personId);
    if (refresh && account?.personalEnabled) account = await pool.refresh(account.id, await resolveCommand());
    const metadata = account ? await readCodexAuthMetadata(account.home) : {};
    const loggedIn = Boolean(account?.personalEnabled && account.account && metadata.revision && !account.credentialIssue);
    const error = failures.get(personId) || account?.credentialIssue
      || (account?.boundAt && !loggedIn ? '个人 Codex 授权已失效或未完成，请重新授权' : '');
    return decorate({ available: Boolean(await resolveCommand()), loggedIn, bound: Boolean(account?.boundAt), deviceLoginActive: false,
      phase: loggedIn ? 'authenticated' : error ? 'failed' : 'idle',
      account: loggedIn ? account.account : null, usage: loggedIn ? account.usage : null,
      checkedAt: account?.checkedAt || null, error });
  }
  return {
    shutdown: () => Promise.all([...jobs.keys()].map(personId => serial(personId, () => release(personId, { stop: true })))),
    getStatus: (personId, options) => serial(personId, () => status(personId, options)),
    startDeviceLogin: (personId, { restart = false } = {}) => serial(personId, async () => {
      if (jobs.has(personId) && !restart) return status(personId);
      await release(personId, { stop: true });
      const account = await pool.ensurePersonalAccount(personId);
      await pool.setPersonalEnabled(account.id, personId, false);
      const lease = await pool.lease(account, { wait: false });
      if (!lease) {
        if (account.personalEnabled) await pool.setPersonalEnabled(account.id, personId, true);
        throw new Error('个人账号仍在执行任务，请在任务结束后重新授权');
      }
      const manager = createManager({ resolveHome: () => account.home, resolveCommand,
        credentialStore: 'file', onProcess: child => lease.setToolProcessId(child.pid),
        onLoginExit: () => { void serial(personId, () => status(personId)).catch(() => {}); } });
      const job = { id: account.id, manager, lease, timer: null };
      jobs.set(personId, job); failures.delete(personId);
      try {
        const state = await manager.startDeviceLogin({ restart: true });
        job.timer = setTimeout(() => {
          void serial(personId, async () => {
            if (jobs.get(personId) !== job) return;
            failures.set(personId, '验证码已过期，请重新绑定');
            await release(personId, { stop: true });
          }).catch(() => {});
        }, Math.max(1, (Date.parse(state.expiresAt || '') || now() + 15 * 60_000) - now()));
        job.timer.unref?.();
        return status(personId);
      } catch (error) { await release(personId, { stop: true }); throw error; }
    }),
    cancelLogin: personId => serial(personId, async () => {
      await release(personId, { stop: true }); failures.delete(personId);
      return status(personId);
    }),
    logout: personId => serial(personId, async () => {
      await release(personId, { stop: true });
      const account = await pool.personalAccount(personId);
      if (!account) return status(personId);
      await pool.setPersonalEnabled(account.id, personId, false);
      const lease = await pool.lease(account, { wait: false });
      if (!lease) {
        if (account.personalEnabled) await pool.setPersonalEnabled(account.id, personId, true);
        throw new Error('个人账号仍在执行任务，请在任务结束后解绑');
      }
      try {
        await createManager({ resolveHome: () => account.home, resolveCommand, credentialStore: 'file' }).logout();
        await pool.setPersonalEnabled(account.id, personId, false, { unbind: true });
        await pool.inspect(account, await resolveCommand(), lease);
        failures.delete(personId);
        return status(personId);
      } finally { await lease.release(); }
    }),
  };
}

export const personalCodexAuthManager = createPersonalCodexAuthManager();
