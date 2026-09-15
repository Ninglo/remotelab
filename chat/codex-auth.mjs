import { spawn } from 'child_process';

import { resolveCodexHomeDir, resolveMachineAccountHomeDir } from '../lib/codex-home.mjs';
import { resolveToolCommandPathAsync } from '../lib/tools.mjs';
import { ensureDir } from './fs-utils.mjs';
import { readCodexAccountStatus, readCodexAuthMetadata } from '../lib/codex-account-status.mjs';

const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10 * 1000;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/;
const DEVICE_URL_PATTERN = /https:\/\/auth\.openai\.com\/codex\/device\b/i;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -\/]*[@-~]/g;

function cleanOutput(value = '') {
  return String(value || '').replace(ANSI_PATTERN, '').replace(/\r/g, '');
}

function createPublicState(state, { available, loggedIn, checkedAt, account = null, accountRevision = '' } = {}) {
  const now = Date.now();
  const expiresAt = Number(state.expiresAt || 0);
  const deviceLoginActive = state.phase === 'starting' || state.phase === 'awaiting';
  return {
    available: available !== false,
    loggedIn: loggedIn === true,
    account: loggedIn === true ? account : null,
    accountRevision: loggedIn === true ? accountRevision : '',
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
      finish({ code: null, stdout, stderr, error: new Error('Codex status check timed out') });
    }, timeoutMs);
    timer.unref?.();
  });
}

export function createCodexAuthManager({
  resolveCommand = () => resolveToolCommandPathAsync('codex'),
  resolveHome = resolveCodexHomeDir,
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
  let usageCache = null;
  let usagePending = null;

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
    const command = await resolveCommand();
    if (!command) return null;
    const codexHome = resolveHome();
    await ensureDir(codexHome);
    return {
      command,
      env: {
        ...baseEnv(),
        HOME: resolveMachineAccountHomeDir(),
        CODEX_HOME: codexHome,
      },
    };
  }

  async function getStatus() {
    const statusGeneration = generation;
    if (activeChild && state.expiresAt && state.expiresAt <= now()) {
      stopActiveLogin();
      state = { ...state, phase: 'failed', error: 'Codex login code expired' };
    }
    let runtime;
    try {
      runtime = await resolveRuntime();
    } catch (error) {
      return createPublicState({ ...state, phase: 'failed', error: error.message || 'Codex is unavailable' }, {
        available: false,
        loggedIn: false,
      });
    }
    if (!runtime) {
      return createPublicState({ ...state, phase: 'unavailable', error: 'Codex is not installed' }, {
        available: false,
        loggedIn: false,
      });
    }

    let result;
    try {
      result = await readCodexAccountStatus({ ...runtime, spawnProcess });
    } catch (error) {
      return createPublicState({ ...state, phase: 'failed', error: error.message });
    }
    if (statusGeneration !== generation) return getStatus();
    const loggedIn = !!result.account;
    if (loggedIn) {
      state = { ...state, phase: 'authenticated', error: '' };
    } else if (!activeChild && state.phase === 'authenticated') {
      state = { ...state, phase: 'idle' };
    }
    return createPublicState(state, {
      available: true,
      loggedIn,
      checkedAt: new Date(now()).toISOString(),
      account: result.account,
      accountRevision: result.accountRevision,
    });
  }

  async function getRateLimits({ force = false } = {}) {
    const runtime = await resolveRuntime();
    if (!runtime) return { status: 'unavailable', buckets: [], accountRevision: '' };
    const { revision } = await readCodexAuthMetadata(runtime.env.CODEX_HOME);
    const key = `${generation}:${runtime.env.CODEX_HOME}:${revision}`;
    if (revision && !force && usageCache?.key === key && usageCache.expiresAt > now()) return usageCache.value;
    if (usagePending?.key === key) return usagePending.promise;
    const promise = (async () => {
      const result = await readCodexAccountStatus({ ...runtime, spawnProcess, includeRateLimits: true });
      const value = { ...result.usage, accountRevision: result.accountRevision, checkedAt: result.checkedAt };
      if (revision && result.credentialRevision === revision) {
        usageCache = { key, value, expiresAt: now() + 60_000 };
      }
      return value;
    })();
    const pending = { key, promise };
    usagePending = pending;
    try { return await promise; }
    finally { if (usagePending === pending) usagePending = null; }
  }

  function stopActiveLogin() {
    generation += 1;
    usageCache = null;
    if (activeChild && !activeChild.killed) {
      activeChild.kill('SIGTERM');
    }
    activeChild = null;
  }

  async function startDeviceLogin({ restart = false } = {}) {
    if (activeChild && !restart) {
      await waitForDeviceCode();
      return getStatus();
    }
    if (activeChild) stopActiveLogin();

    const runtime = await resolveRuntime();
    if (!runtime) {
      state = { ...state, phase: 'unavailable', error: 'Codex is not installed' };
      return createPublicState(state, { available: false, loggedIn: false });
    }

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
      activeChild = spawnProcess(runtime.command, ['login', '--device-auth'], {
        env: runtime.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      activeChild = null;
      state = { ...state, phase: 'failed', error: error.message || 'Failed to start Codex login' };
      return createPublicState(state, { available: true, loggedIn: false });
    }

    const consumeOutput = (chunk) => {
      if (currentGeneration !== generation) return;
      combinedOutput = cleanOutput(`${combinedOutput}${String(chunk || '')}`).slice(-16 * 1024);
      const code = combinedOutput.match(DEVICE_CODE_PATTERN)?.[0] || '';
      const verificationUri = combinedOutput.match(DEVICE_URL_PATTERN)?.[0]
        || state.verificationUri;
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
      state = { ...state, phase: 'failed', error: error.message || 'Codex login failed' };
      notifyWaiters();
    });
    activeChild.on('close', (code) => {
      if (currentGeneration !== generation) return;
      activeChild = null;
      state = code === 0
        ? { ...state, phase: 'completed', error: '' }
        : { ...state, phase: 'failed', error: 'Codex login did not complete' };
      notifyWaiters();
    });

    await waitForDeviceCode();
    return getStatus();
  }

  async function logout() {
    stopActiveLogin();
    const runtime = await resolveRuntime();
    if (!runtime) {
      state = { ...state, phase: 'unavailable', error: 'Codex is not installed' };
      return createPublicState(state, { available: false, loggedIn: false });
    }

    const result = await waitForProcess(runtime.command, ['logout'], {
      env: runtime.env,
      spawnProcess,
    });
    if (result.error || result.code !== 0) {
      throw new Error(result.error?.message || 'Failed to log out of Codex');
    }

    state = {
      phase: 'idle',
      verificationUri: '',
      userCode: '',
      expiresAt: 0,
      error: '',
    };
    const status = await getStatus();
    if (status.loggedIn) throw new Error('Codex is still logged in after logout');
    return status;
  }

  return {
    getStatus,
    getRateLimits,
    logout,
    startDeviceLogin,
    stopActiveLogin,
  };
}

export const codexAuthManager = createCodexAuthManager();
