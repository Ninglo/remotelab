import { codexAccounts } from '../lib/codex-accounts.mjs';
import { readCodexAuthMetadata } from '../lib/codex-account-status.mjs';
import { resolveToolCommandPathAsync } from '../lib/tools.mjs';

export function createCodexAccountListAuthManager({ createManager, pool = codexAccounts,
  resolveCommand = () => resolveToolCommandPathAsync('codex') } = {}) {
  let login = null;
  const withList = async status => ({ ...status, accountList: await pool.list() });
  async function getStatus() {
    if (login) {
      const status = await login.manager.getStatus();
      if (status.loggedIn) {
        const completed = login;
        await pool.inspect(await pool.account(completed.id), await resolveCommand(), completed.lease);
        await pool.select(completed.id);
        login = null; await completed.lease.release();
        return getStatus();
      }
      if (!status.deviceLoginActive) { await login.lease.release(); login = null; }
      return withList(status);
    }
    const account = await pool.account();
    if (!account.account) await pool.refresh(account.id, await resolveCommand());
    const current = await pool.account(account.id);
    const metadata = await readCodexAuthMetadata(current.home);
    const loggedIn = !!current.account && (!!metadata.revision || current.id === 'default');
    return withList({ available: Boolean(await resolveCommand()), loggedIn,
      phase: loggedIn ? 'authenticated' : 'idle', deviceLoginActive: false,
      account: loggedIn ? current.account : null, accountRevision: metadata.revision || current.usage?.accountRevision || '',
      checkedAt: current.checkedAt || new Date().toISOString(), error: '' });
  }
  async function startDeviceLogin({ label = '', accountId, restart = false } = {}) {
    if (login && !restart) return getStatus();
    if (login) { await login.manager.stopActiveLogin(); await login.lease.release(); login = null; }
    const account = accountId ? await pool.account(accountId) : await pool.add(label);
    const lease = await pool.lease(account, { wait: false });
    if (!lease) throw new Error('这个账号正在执行任务，请等任务结束后重新登录');
    const manager = createManager({ resolveHome: () => account.home, resolveCommand,
      credentialStore: account.id === 'default' ? undefined : 'file' });
    login = { id: account.id, manager, lease };
    try { return withList(await manager.startDeviceLogin({ restart: true })); }
    catch (error) { login = null; await lease.release(); throw error; }
  }
  return {
    getStatus, startDeviceLogin,
    async getRateLimits() {
      if (login) return { status: 'unavailable', buckets: [], accountRevision: '' };
      const account = await pool.refresh(null, await resolveCommand());
      return account.usage || { status: 'unavailable', buckets: [], accountRevision: '' };
    },
    async listAccounts({ refresh = false } = {}) { return pool.list({ refresh, command: await resolveCommand() }); },
    async setAccountPolicy(autoSwitch) { return pool.policy(autoSwitch); },
    async switchAccount({ accountId } = {}) {
      if (!accountId) return startDeviceLogin({ restart: true });
      await pool.select(accountId); return getStatus();
    },
    async logout() {
      const account = await pool.account(); const lease = await pool.lease(account, { wait: false });
      if (!lease) throw new Error('这个账号正在执行任务，请等任务结束后退出');
      try {
        const manager = createManager({ resolveHome: () => account.home, resolveCommand,
          credentialStore: account.id === 'default' ? undefined : 'file' });
        await manager.logout(); await pool.inspect(account, await resolveCommand(), lease); return getStatus();
      } finally { await lease.release(); }
    },
  };
}
