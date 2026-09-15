import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const text = value => typeof value === 'string' ? value.trim().slice(0, 320) : '';
const digest = value => createHash('sha256').update(value).digest('hex');

// These claims only supply a display name. Authentication remains Codex's job.
export async function readCodexAuthMetadata(home) {
  try {
    const raw = await readFile(join(home, 'auth.json'), 'utf8');
    const auth = JSON.parse(raw);
    let claims = {};
    try {
      claims = JSON.parse(Buffer.from(auth.tokens?.id_token?.split('.')[1] || '', 'base64url').toString());
    } catch {}
    return { revision: digest(raw), name: text(claims.name), email: text(claims.email) };
  } catch {
    return { revision: '', name: '', email: '' };
  }
}

function normalizeWindow(value) {
  if (!value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0) return null;
  const reset = Number.isFinite(value.resetsAt) && value.resetsAt > 0
    ? new Date(value.resetsAt * 1000) : null;
  return {
    remainingPercent: Math.max(0, Math.min(100, 100 - value.usedPercent)),
    windowDurationMins: Number.isFinite(value.windowDurationMins) && value.windowDurationMins > 0
      ? value.windowDurationMins : null,
    resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
  };
}

function normalizeLimits(result) {
  const byId = result?.rateLimitsByLimitId;
  const buckets = byId && typeof byId === 'object' && Object.keys(byId).length
    ? Object.entries(byId) : [['codex', result?.rateLimits]];
  return buckets.slice(0, 20).flatMap(([id, bucket]) => {
    if (!bucket) return [];
    const primary = normalizeWindow(bucket.primary);
    const secondary = normalizeWindow(bucket.secondary);
    if (!primary && !secondary) return [];
    return [{ id: text(bucket.limitId) || text(id), name: text(bucket.limitName), primary, secondary }];
  });
}

/** A bounded, read-only RPC exchange. No thread, turn, prompt, or model request. */
export async function readCodexAccountStatus({
  command, env, includeRateLimits = false, spawnProcess = spawn, timeoutMs = 12000,
}) {
  const before = await readCodexAuthMetadata(env.CODEX_HOME);
  const result = await new Promise((resolve, reject) => {
    let child, timer, killTimer, buffer = '', settled = false, account = null;
    const finish = (error, usage = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdin?.end();
      if (child && child.exitCode == null) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        killTimer.unref?.();
      }
      if (error) reject(new Error(error));
      else resolve({ account, usage });
    };
    const send = message => {
      if (!settled) child.stdin.write(JSON.stringify(message) + '\n');
    };
    try {
      child = spawnProcess(command, ['app-server', '--listen', 'stdio://'], {
        env, stdio: ['pipe', 'pipe', 'ignore'],
      });
      child.on('error', () => finish('Codex account check failed'));
      child.on('close', () => {
        clearTimeout(killTimer);
        finish('Codex account connection closed');
      });
      child.stdin.on('error', () => finish('Codex account connection closed'));
      child.stdout.on('data', chunk => {
        if (settled) return;
        buffer += chunk;
        if (buffer.length > 1024 * 1024) return finish('Codex account response is too large');
        let end;
        while (!settled && (end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.method || ![1, 2, 3].includes(message.id)) continue;
          if (message.error) {
            // Never pass provider errors, stdout, or credentials to the browser.
            if (message.id === 3) finish(null, { status: 'unavailable', buckets: [] });
            else finish('Codex account check failed');
            continue;
          }
          if (message.id === 1) {
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'account/read', params: { refreshToken: false } });
          } else if (message.id === 2) {
            if (!Object.hasOwn(message.result || {}, 'account')) {
              finish('Codex account response is invalid');
              continue;
            }
            const value = message.result.account;
            if (value !== null && (typeof value !== 'object' || !text(value.type))) {
              finish('Codex account response is invalid');
              continue;
            }
            account = value ? {
              type: text(value.type), email: text(value.email), planType: text(value.planType), name: text(value.name),
            } : null;
            if (!includeRateLimits) finish(null);
            else if (account?.type === 'chatgpt') send({ id: 3, method: 'account/rateLimits/read', params: {} });
            else finish(null, { status: account ? 'unsupported' : 'signed_out', buckets: [] });
          } else if (message.id === 3) {
            const buckets = normalizeLimits(message.result);
            finish(null, { status: buckets.length ? 'ready' : 'unavailable', buckets });
          }
        }
      });
      timer = setTimeout(() => {
        if (includeRateLimits && account) finish(null, { status: 'unavailable', buckets: [] });
        else finish('Codex account check timed out');
      }, timeoutMs);
      timer.unref?.();
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'remotelab_account_status', version: '1.0.0' } } });
    } catch {
      finish('Codex account check failed');
    }
  });
  const after = await readCodexAuthMetadata(env.CODEX_HOME);
  if (before.revision !== after.revision) throw new Error('Codex account changed; check status again');
  if (result.account?.type === 'chatgpt' && result.account.email && result.account.email === after.email) {
    result.account.name ||= after.name;
  }
  return {
    ...result,
    accountRevision: result.account ? digest(JSON.stringify([after.revision, result.account])) : '',
    credentialRevision: after.revision,
    checkedAt: new Date().toISOString(),
  };
}
