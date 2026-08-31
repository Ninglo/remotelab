import { spawn } from 'child_process';
import { chmod, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import {
  PI_AGENT_DIR,
  PI_CODEX_LOGIN_HOME_DIR,
} from '../lib/config.mjs';
import { resolveToolCommandPathAsync } from '../lib/tools.mjs';
import {
  createSerialTaskQueue,
  ensureDir,
  removePath,
  writeJsonAtomic,
} from './fs-utils.mjs';

const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000;
const STATUS_TIMEOUT_MS = 15 * 1000;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/;
const DEVICE_URL_PATTERN = /https:\/\/auth\.openai\.com\/codex\/device\b/i;
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

function createPublicState(state, { available, loggedIn, checkedAt } = {}) {
  const now = Date.now();
  const expiresAt = Number(state.expiresAt || 0);
  const deviceLoginActive = ['starting', 'awaiting', 'synchronizing'].includes(state.phase);
  return {
    available: available !== false,
    loggedIn: loggedIn === true,
    phase: loggedIn === true ? 'authenticated' : state.phase,
    deviceLoginActive,
    verificationUri: deviceLoginActive ? state.verificationUri : '',
    userCode: deviceLoginActive ? state.userCode : '',
    expiresAt: deviceLoginActive && expiresAt > now ? new Date(expiresAt).toISOString() : '',
    checkedAt: checkedAt || new Date().toISOString(),
    error: loggedIn === true ? '' : state.error,
  };
}

function waitForProcess(command, args, { env, timeoutMs = STATUS_TIMEOUT_MS, spawnProcess = spawn } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

    const timer = setTimeout(() => {
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
  resolveCodexCommand = () => resolveToolCommandPathAsync('codex'),
  resolveAgentDir = () => PI_AGENT_DIR,
  resolveLoginHome = () => PI_CODEX_LOGIN_HOME_DIR,
  spawnProcess = spawn,
  baseEnv = () => process.env,
  now = () => Date.now(),
} = {}) {
  let activeChild = null;
  let generation = 0;
  let state = {
    phase: 'idle',
    verificationUri: '',
    userCode: '',
    expiresAt: 0,
    error: '',
  };
  const waiters = new Set();
  const credentialQueue = createSerialTaskQueue();

  function notifyWaiters() {
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  function waitForDeviceCode(timeoutMs = STATUS_TIMEOUT_MS) {
    if (state.userCode || state.phase === 'failed') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(done);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.add(done);
    });
  }

  async function resolveRuntime() {
    const [piCommand, codexCommand] = await Promise.all([
      resolvePiCommand(),
      resolveCodexCommand(),
    ]);
    const agentDir = resolveAgentDir();
    const loginHome = resolveLoginHome();
    await Promise.all([ensureDir(agentDir), ensureDir(loginHome)]);
    return {
      piCommand,
      codexCommand,
      agentDir,
      loginHome,
      env: {
        ...baseEnv(),
        HOME: homedir(),
        PI_CODING_AGENT_DIR: agentDir,
      },
    };
  }

  function stopActiveLogin() {
    generation += 1;
    if (activeChild && !activeChild.killed) activeChild.kill('SIGTERM');
    activeChild = null;
  }

  async function getStatus() {
    if (activeChild && state.expiresAt && state.expiresAt <= now()) {
      stopActiveLogin();
      state = { ...state, phase: 'failed', error: 'Pi login code expired' };
    }
    let runtime;
    try {
      runtime = await resolveRuntime();
    } catch (error) {
      return createPublicState({ ...state, phase: 'failed', error: error.message || 'Pi is unavailable' }, {
        available: false,
        loggedIn: false,
      });
    }
    if (!runtime.piCommand) {
      return createPublicState({ ...state, phase: 'unavailable', error: 'Pi is not installed' }, {
        available: false,
        loggedIn: false,
      });
    }
    if (activeChild || state.phase === 'synchronizing') {
      return createPublicState(state, {
        available: true,
        loggedIn: false,
        checkedAt: new Date(now()).toISOString(),
      });
    }

    const result = await waitForProcess(
      runtime.piCommand,
      ['auth', 'check', '--provider', OPENAI_CODEX_PROVIDER, '--json', '--no-refresh'],
      { env: runtime.env, spawnProcess },
    );
    const authStatus = parseJsonLine(`${result.stdout}\n${result.stderr}`);
    const piAuth = await readJsonObject(join(runtime.agentDir, 'auth.json'), { missing: {} });
    const credential = piAuth[OPENAI_CODEX_PROVIDER];
    const credentialExpiresAt = Number(credential?.expires || 0);
    const credentialIsCurrent = credential?.type === 'oauth'
      && !!trimString(credential.access)
      && !!trimString(credential.refresh)
      && credentialExpiresAt > now();
    const loggedIn = authStatus?.status === 'ready' && credentialIsCurrent;
    if (loggedIn && !activeChild && state.phase !== 'awaiting' && state.phase !== 'synchronizing') {
      state = { ...state, phase: 'authenticated', error: '' };
    } else if (!loggedIn && !activeChild && state.phase === 'authenticated') {
      state = { ...state, phase: 'idle', error: '' };
    }
    if (
      !loggedIn
      && !activeChild
      && (authStatus?.status === 'invalid' || credential?.type === 'oauth')
      && state.phase !== 'failed'
    ) {
      state = { ...state, phase: 'failed', error: 'Pi OpenAI login expired or is invalid' };
    }
    return createPublicState(state, {
      available: true,
      loggedIn,
      checkedAt: new Date(now()).toISOString(),
    });
  }

  async function startDeviceLogin({ restart = false } = {}) {
    if (activeChild && !restart) {
      await waitForDeviceCode();
      return getStatus();
    }
    if (activeChild) stopActiveLogin();

    const runtime = await resolveRuntime();
    if (!runtime.piCommand || !runtime.codexCommand) {
      const missing = !runtime.piCommand ? 'Pi' : 'Codex';
      state = { ...state, phase: 'unavailable', error: `${missing} is not installed` };
      return createPublicState(state, { available: false, loggedIn: false });
    }

    await removePath(runtime.loginHome);
    await ensureDir(runtime.loginHome);
    const currentGeneration = ++generation;
    state = {
      phase: 'starting',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: '',
      expiresAt: now() + DEVICE_LOGIN_TTL_MS,
      error: '',
    };

    let combinedOutput = '';
    try {
      activeChild = spawnProcess(runtime.codexCommand, ['login', '--device-auth'], {
        env: {
          ...runtime.env,
          CODEX_HOME: runtime.loginHome,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      activeChild = null;
      state = { ...state, phase: 'failed', error: error.message || 'Failed to start Pi login' };
      return createPublicState(state, { available: true, loggedIn: false });
    }

    const consumeOutput = (chunk) => {
      if (currentGeneration !== generation) return;
      combinedOutput = cleanOutput(`${combinedOutput}${String(chunk || '')}`).slice(-16 * 1024);
      const code = combinedOutput.match(DEVICE_CODE_PATTERN)?.[0] || '';
      const verificationUri = combinedOutput.match(DEVICE_URL_PATTERN)?.[0] || state.verificationUri;
      if (code) {
        state = {
          ...state,
          phase: 'awaiting',
          verificationUri,
          userCode: code,
          error: '',
        };
        notifyWaiters();
      }
    };
    activeChild.stdout?.on('data', consumeOutput);
    activeChild.stderr?.on('data', consumeOutput);
    activeChild.on('error', (error) => {
      if (currentGeneration !== generation) return;
      activeChild = null;
      state = { ...state, phase: 'failed', error: error.message || 'Pi login failed' };
      notifyWaiters();
    });
    activeChild.on('close', (code) => {
      if (currentGeneration !== generation) return;
      activeChild = null;
      if (code !== 0) {
        state = { ...state, phase: 'failed', error: 'Pi login did not complete' };
        notifyWaiters();
        return;
      }
      state = { ...state, phase: 'synchronizing', error: '' };
      void credentialQueue(async () => {
        await syncCodexAuthToPi({
          codexAuthFile: join(runtime.loginHome, 'auth.json'),
          piAuthFile: join(runtime.agentDir, 'auth.json'),
        });
      }).then(() => {
        if (currentGeneration !== generation) return;
        state = { ...state, phase: 'completed', error: '' };
        notifyWaiters();
      }).catch((error) => {
        if (currentGeneration !== generation) return;
        state = { ...state, phase: 'failed', error: error.message || 'Failed to save Pi login' };
        notifyWaiters();
      });
    });

    await waitForDeviceCode();
    return getStatus();
  }

  async function logout() {
    stopActiveLogin();
    const runtime = await resolveRuntime();
    if (!runtime.piCommand) {
      state = { ...state, phase: 'unavailable', error: 'Pi is not installed' };
      return createPublicState(state, { available: false, loggedIn: false });
    }
    await credentialQueue(() => removePiCodexCredential({
      piAuthFile: join(runtime.agentDir, 'auth.json'),
    }));
    state = {
      phase: 'idle',
      verificationUri: '',
      userCode: '',
      expiresAt: 0,
      error: '',
    };
    const status = await getStatus();
    if (status.loggedIn) throw new Error('Pi is still logged in after logout');
    return status;
  }

  return {
    getStatus,
    logout,
    startDeviceLogin,
    stopActiveLogin,
  };
}

export const piAuthManager = createPiAuthManager();
