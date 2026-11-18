import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCodexAccountStatus } from '../lib/codex-account-status.mjs';
import { acquireProviderRuntimeLease } from './provider-runtime-queue.mjs';
import { ensurePiModelBaseline } from './pi-model-baseline.mjs';

async function readOwnedAccess(home) {
  let tokens;
  try {
    ({ tokens } = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')));
  } catch {
    throw new Error('所选 Codex 账号缺少可用的文件登录，请在 Codex 中检查授权。');
  }
  const access = tokens?.access_token;
  let claims;
  try { claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url')); } catch {}
  const expires = Number(claims?.exp) * 1000;
  const accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!accountId || !Number.isFinite(expires)
      || (tokens.account_id && tokens.account_id !== accountId)) {
    throw new Error('所选 Codex 账号的登录身份无法校验，请在 Codex 中检查授权。');
  }
  return { access, expires, accountId, subject: claims.sub || null };
}

async function usableAccess(account, { env, resolveCodexCommand, isCancelled, runId,
  query = readCodexAccountStatus } = {}) {
  const initial = await readOwnedAccess(account.home);
  if (initial.expires > Date.now()) return initial;
  // Only Codex refreshes its managed login. Serialize Pi-triggered refreshes
  // for one account, leaving normal work on other accounts independent.
  const key = createHash('sha256').update(account.home).digest('hex');
  const refreshLease = await acquireProviderRuntimeLease({ queueKey: 'codex-refresh-' + key, runId, isCancelled });
  try {
    let credential = await readOwnedAccess(account.home);
    if (credential.expires <= Date.now()) {
      const result = await query({
        command: await resolveCodexCommand(),
        env: { ...env, CODEX_HOME: account.home, CODEX_SQLITE_HOME: account.sqliteHome },
        credentialStore: account.id === 'default' ? undefined : 'file',
        refreshToken: true,
        onProcess: child => refreshLease.setToolProcessId(child.pid),
      });
      if (result.account?.type !== 'chatgpt') throw new Error('所选 Codex 登录不可用，请重新授权。');
      credential = await readOwnedAccess(account.home);
    }
    if (credential.expires <= Date.now() || credential.accountId !== initial.accountId || credential.subject !== initial.subject) {
      throw new Error('所选 Codex 登录已过期或身份已变更，请检查授权后重试。');
    }
    return credential;
  } finally {
    await refreshLease.release();
  }
}

// A leased account supplies one current access token. Keep it in a run-local
// Pi home, separate from settings, long-lived credentials and native history.
export async function preparePooledPiRuntime(account, options = {}) {
  const { access, expires, accountId } = await usableAccess(account, options);
  const dir = await mkdtemp(join(tmpdir(), 'remotelab-pi-pooled-'));
  const close = () => rm(dir, { recursive: true, force: true });
  try {
    const sessionDir = join(options.env.PI_CODING_AGENT_DIR, 'sessions');
    await mkdir(sessionDir, { mode: 0o700, recursive: true });
    await symlink(sessionDir, join(dir, 'sessions'), 'dir');
    await ensurePiModelBaseline(dir);
    await writeFile(join(dir, 'auth.json'), JSON.stringify({
      'openai-codex': { type: 'oauth', access, expires, accountId, refresh: '' },
    }), { mode: 0o600 });
    return { dir, close };
  } catch (error) {
    await close();
    throw error;
  }
}
