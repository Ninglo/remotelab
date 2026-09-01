import { spawn } from 'child_process';
import { chmod, readFile } from 'fs/promises';
import { join } from 'path';

import { resolveCodexHomeDir, resolveMachineAccountHomeDir } from '../lib/codex-home.mjs';
import { PI_AGENT_DIR } from '../lib/config.mjs';
import { resolveToolCommandPathAsync } from '../lib/tools.mjs';
import {
  createSerialTaskQueue,
  ensureDir,
  writeJsonAtomic,
} from './fs-utils.mjs';

const STATUS_TIMEOUT_MS = 15 * 1000;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
const OPENAI_CODEX_PROVIDER = 'openai-codex';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanOutput(value = '') {
  return String(value || '').replace(ANSI_PATTERN, '').replace(/\r/g, '');
}

function parseJsonLine(output = '') {
  const lines = cleanOutput(output).split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function decodeJwtExpiry(accessToken) {
  const parts = trimString(accessToken).split('.');
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const expirySeconds = Number(payload?.exp || 0);
    return Number.isFinite(expirySeconds) && expirySeconds > 0 ? expirySeconds * 1000 : 0;
  } catch {
    return 0;
  }
}

async function readJsonObject(pathname, { missing = {} } = {}) {
  let raw;
  try {
    raw = await readFile(pathname, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...missing };
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON object at ${pathname}`);
  }
  return parsed;
}

function createPublicState(state, { available = true, loggedIn = false, checkedAt = '' } = {}) {
  return {
    available,
    loggedIn,
    phase: loggedIn ? 'authenticated' : state.phase,
    deviceLoginActive: false,
    verificationUri: '',
    userCode: '',
    expiresAt: '',
    checkedAt: checkedAt || new Date().toISOString(),
    error: loggedIn ? '' : state.error,
  };
}

function waitForProcess(command, args, { env, timeoutMs = STATUS_TIMEOUT_MS, spawnProcess = spawn } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnProcess(command, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, stdout, stderr, error });
      return;
    }

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (error) => finish({ code: null, stdout, stderr, error }));
    child.on('close', (code) => finish({ code, stdout, stderr, error: null }));

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: null, stdout, stderr, error: new Error('Pi login status check timed out') });
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function syncCodexAuthToPi({
  codexAuthFile,
  piAuthFile = join(PI_AGENT_DIR, 'auth.json'),
} = {}) {
  if (!trimString(codexAuthFile)) throw new Error('Codex auth source is required');
  const codexAuth = await readJsonObject(codexAuthFile);
  const access = trimString(codexAuth?.tokens?.access_token);
  const refresh = trimString(codexAuth?.tokens?.refresh_token);
  const accountId = trimString(codexAuth?.tokens?.account_id);
  const expires = decodeJwtExpiry(access);
  if (!access || !refresh || !accountId || expires <= Date.now()) {
    throw new Error('Codex login did not produce a usable OpenAI credential');
  }

  const piAuth = await readJsonObject(piAuthFile, { missing: {} });
  await writeJsonAtomic(piAuthFile, {
    ...piAuth,
    [OPENAI_CODEX_PROVIDER]: {
      type: 'oauth',
      access,
      refresh,
      expires,
      accountId,
    },
  });
  await chmod(piAuthFile, 0o600);
  return { provider: OPENAI_CODEX_PROVIDER, expiresAt: new Date(expires).toISOString() };
}

export async function removePiCodexCredential({
  piAuthFile = join(PI_AGENT_DIR, 'auth.json'),
} = {}) {
  const piAuth = await readJsonObject(piAuthFile, { missing: {} });
  if (!Object.hasOwn(piAuth, OPENAI_CODEX_PROVIDER)) return false;
  const next = { ...piAuth };
  delete next[OPENAI_CODEX_PROVIDER];
  await writeJsonAtomic(piAuthFile, next);
  await chmod(piAuthFile, 0o600);
  return true;
}

export function createPiAuthManager({
  resolvePiCommand = () => resolveToolCommandPathAsync('pi'),
  resolveAgentDir = () => PI_AGENT_DIR,
  resolveCodexHome = resolveCodexHomeDir,
  spawnProcess = spawn,
  baseEnv = () => process.env,
  now = () => Date.now(),
} = {}) {
  let state = { phase: 'idle', error: '' };
  const credentialQueue = createSerialTaskQueue();

  async function resolveRuntime() {
    const piCommand = await resolvePiCommand();
    const agentDir = resolveAgentDir();
    const codexHome = resolveCodexHome();
    await Promise.all([ensureDir(agentDir), ensureDir(codexHome)]);
    return {
      piCommand,
      agentDir,
      codexHome,
      env: {
        ...baseEnv(),
        HOME: resolveMachineAccountHomeDir(),
        PI_CODING_AGENT_DIR: agentDir,
      },
    };
  }

  async function getStatus() {
    let runtime;
    try {
      runtime = await resolveRuntime();
    } catch (error) {
      return createPublicState({ phase: 'failed', error: error.message || 'Pi is unavailable' }, {
        available: false,
        loggedIn: false,
      });
    }
    if (!runtime.piCommand) {
      return createPublicState({ phase: 'unavailable', error: 'Pi is not installed' }, {
        available: false,
        loggedIn: false,
      });
    }

    const result = await waitForProcess(
      runtime.piCommand,
      ['auth', 'check', '--provider', OPENAI_CODEX_PROVIDER, '--json', '--no-refresh'],
      { env: runtime.env, spawnProcess },
    );
    const authStatus = parseJsonLine(`${result.stdout}\n${result.stderr}`);
    const piAuth = await readJsonObject(join(runtime.agentDir, 'auth.json'), { missing: {} });
    const codexAuth = await readJsonObject(join(runtime.codexHome, 'auth.json'), { missing: {} });
    const credential = piAuth[OPENAI_CODEX_PROVIDER];
    const credentialExpiresAt = Number(credential?.expires || 0);
    const machineAccountId = trimString(codexAuth?.tokens?.account_id);
    const credentialIsCurrent = credential?.type === 'oauth'
      && !!trimString(credential.access)
      && !!trimString(credential.refresh)
      && credentialExpiresAt > now();
    const credentialMatchesMachine = !!machineAccountId
      && trimString(credential?.accountId) === machineAccountId;
    const loggedIn = authStatus?.status === 'ready'
      && credentialIsCurrent
      && credentialMatchesMachine;

    if (loggedIn) {
      state = { phase: 'authenticated', error: '' };
    } else if (state.phase === 'authenticated' || state.phase === 'completed') {
      state = { phase: 'idle', error: '' };
    } else if (credentialIsCurrent && !credentialMatchesMachine) {
      state = { phase: 'failed', error: 'Pi OpenAI credential does not match this machine Codex login' };
    } else if (authStatus?.status === 'invalid' || credential?.type === 'oauth') {
      state = { phase: 'failed', error: 'Pi OpenAI credential is expired or invalid' };
    }

    return createPublicState(state, {
      available: true,
      loggedIn,
      checkedAt: new Date(now()).toISOString(),
    });
  }

  async function syncCodexLogin() {
    const runtime = await resolveRuntime();
    if (!runtime.piCommand) {
      state = { phase: 'unavailable', error: 'Pi is not installed' };
      return createPublicState(state, { available: false, loggedIn: false });
    }

    state = { phase: 'synchronizing', error: '' };
    try {
      await credentialQueue(() => syncCodexAuthToPi({
        codexAuthFile: join(runtime.codexHome, 'auth.json'),
        piAuthFile: join(runtime.agentDir, 'auth.json'),
      }));
      state = { phase: 'completed', error: '' };
      return await getStatus();
    } catch {
      state = {
        phase: 'failed',
        error: 'Sign in to Codex on this machine before enabling the OpenAI provider in Pi',
      };
      return createPublicState(state, { available: true, loggedIn: false });
    }
  }

  async function logout() {
    const runtime = await resolveRuntime();
    if (!runtime.piCommand) {
      state = { phase: 'unavailable', error: 'Pi is not installed' };
      return createPublicState(state, { available: false, loggedIn: false });
    }
    await credentialQueue(() => removePiCodexCredential({
      piAuthFile: join(runtime.agentDir, 'auth.json'),
    }));
    state = { phase: 'idle', error: '' };
    return await getStatus();
  }

  return {
    getStatus,
    logout,
    syncCodexLogin,
    stopActiveLogin() {},
  };
}

export const piAuthManager = createPiAuthManager();
