import { spawn } from 'node:child_process';

import { resolveMachineAccountHomeDir } from '../lib/codex-home.mjs';
import { resolveToolCommandPathAsync } from '../lib/tools.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';

const LOGIN_TTL_MS = 15 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10 * 1000;
const AUTH_URL_PATTERN = /https:\/\/[^\s<>"']+(?=\s)/g;
const LOGIN_ENV_OVERRIDES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

function cleanOutput(value) {
  return String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

function findLoginUrl(output) {
  for (const match of cleanOutput(output).matchAll(AUTH_URL_PATTERN)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol === 'https:'
        && ['claude.com', 'claude.ai'].includes(url.hostname)
        && url.pathname.endsWith('/oauth/authorize')) return url.href;
    } catch {}
  }
  return '';
}

function runCommand(command, args, { env, spawnProcess, timeoutMs = STATUS_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timer;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnProcess(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ code: null, stdout, stderr, error });
      return;
    }
    child.stdout?.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-16 * 1024); });
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16 * 1024); });
    child.on('error', (error) => finish({ code: null, stdout, stderr, error }));
    child.on('close', (code) => finish({ code, stdout, stderr, error: null }));
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: null, stdout, stderr, error: new Error('Claude auth command timed out') });
    }, timeoutMs);
    timer.unref?.();
  });
}

export function createClaudeAuthManager({
  resolveCommand = () => resolveToolCommandPathAsync('claude'),
  buildEnv = buildToolProcessEnv,
  resolveHome = resolveMachineAccountHomeDir,
  spawnProcess = spawn,
  now = () => Date.now(),
} = {}) {
  let activeChild = null;
  let generation = 0;
  let state = { phase: 'idle', verificationUri: '', expiresAt: 0, error: '' };
  const waiters = new Set();

  function notifyWaiters() {
    for (const finish of waiters) finish();
    waiters.clear();
  }

  function waitForLoginUrl() {
    if (state.verificationUri || state.phase === 'failed') return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); waiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, STATUS_TIMEOUT_MS);
      timer.unref?.();
      waiters.add(finish);
    });
  }

  async function resolveRuntime() {
    const command = await resolveCommand();
    if (!command) return null;
    const effectiveEnv = { ...buildEnv(), HOME: resolveHome() };
    delete effectiveEnv.CLAUDECODE;
    delete effectiveEnv.CLAUDE_CODE_ENTRYPOINT;
    const loginEnv = { ...effectiveEnv, BROWSER: '/bin/true', NO_COLOR: '1' };
    for (const key of LOGIN_ENV_OVERRIDES) delete loginEnv[key];
    return { command, effectiveEnv, loginEnv };
  }

  function publicState({ available = true, loggedIn = false, authMethod = 'none', apiKeyOverride = false } = {}) {
    const loginActive = !!activeChild && ['starting', 'awaiting', 'verifying'].includes(state.phase);
    return {
      available,
      loggedIn,
      authMethod,
      apiKeyOverride,
      effectiveAuthMethod: apiKeyOverride ? 'api_key' : authMethod,
      phase: loginActive ? state.phase : (loggedIn ? 'authenticated' : state.phase),
      loginActive,
      verificationUri: loginActive ? state.verificationUri : '',
      expiresAt: loginActive ? new Date(state.expiresAt).toISOString() : '',
      checkedAt: new Date(now()).toISOString(),
      error: state.error,
    };
  }

  async function getStatus() {
    if (activeChild && state.expiresAt <= now()) {
      stopActiveLogin();
      state = { ...state, phase: 'failed', error: 'Claude login expired' };
    }
    const runtime = await resolveRuntime();
    if (!runtime) return publicState({ available: false });
    const status = await runCommand(runtime.command, ['auth', 'status', '--json'], {
      env: runtime.loginEnv,
      spawnProcess,
    });
    const apiKeyOverride = !!(runtime.effectiveEnv.ANTHROPIC_API_KEY || runtime.effectiveEnv.ANTHROPIC_AUTH_TOKEN);
    if (status.error) return { ...publicState({ apiKeyOverride }), phase: 'failed', error: status.error.message };
    let parsed;
    try { parsed = JSON.parse(status.stdout.trim()); }
    catch { return { ...publicState({ apiKeyOverride }), phase: 'failed', error: 'Claude login status was invalid' }; }
    if (status.code !== 0 && parsed.loggedIn !== false) {
      return { ...publicState({ apiKeyOverride }), phase: 'failed', error: 'Claude login status failed' };
    }
    const authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : 'none';
    const loggedIn = parsed.loggedIn === true && authMethod !== 'api_key';
    if (loggedIn && !activeChild) state = { ...state, phase: 'authenticated', error: '' };
    else if (!loggedIn && !activeChild && state.phase === 'authenticated') state = { ...state, phase: 'idle' };
    return publicState({
      loggedIn,
      authMethod: loggedIn ? authMethod : 'none',
      apiKeyOverride,
    });
  }

  function stopActiveLogin() {
    generation += 1;
    const child = activeChild;
    activeChild = null;
    if (child && child.exitCode == null) {
      try { child.kill('SIGTERM'); } catch {}
    }
    notifyWaiters();
  }

  async function startLogin({ restart = false } = {}) {
    if (activeChild && !restart) {
      await waitForLoginUrl();
      return getStatus();
    }
    if (activeChild) stopActiveLogin();
    const runtime = await resolveRuntime();
    if (!runtime) return publicState({ available: false });
    const currentGeneration = ++generation;
    state = { phase: 'starting', verificationUri: '', expiresAt: now() + LOGIN_TTL_MS, error: '' };
    let output = '';
    try {
      activeChild = spawnProcess(runtime.command, ['auth', 'login', '--claudeai'], {
        env: runtime.loginEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      state = { ...state, phase: 'failed', error: error.message || 'Claude login failed' };
      return publicState();
    }
    const child = activeChild;
    const consumeOutput = (chunk) => {
      if (currentGeneration !== generation) return;
      output = cleanOutput(`${output}${chunk}`).slice(-64 * 1024);
      const verificationUri = findLoginUrl(output);
      if (verificationUri && verificationUri !== state.verificationUri) {
        state = { ...state, phase: 'awaiting', verificationUri };
        notifyWaiters();
      }
    };
    child.stdout?.on('data', consumeOutput);
    child.stderr?.on('data', consumeOutput);
    child.on('error', (error) => {
      if (currentGeneration !== generation) return;
      activeChild = null;
      state = { ...state, phase: 'failed', error: error.message || 'Claude login failed' };
      notifyWaiters();
    });
    child.on('close', (code) => {
      if (currentGeneration !== generation) return;
      activeChild = null;
      state = code === 0
        ? { ...state, phase: 'completed', error: '' }
        : { ...state, phase: 'failed', error: 'Claude login did not complete' };
      notifyWaiters();
    });
    const loginTimer = setTimeout(() => {
      if (currentGeneration !== generation || !activeChild) return;
      stopActiveLogin();
      state = { ...state, phase: 'failed', error: 'Claude login expired' };
    }, LOGIN_TTL_MS);
    loginTimer.unref?.();
    child.once('close', () => clearTimeout(loginTimer));
    await waitForLoginUrl();
    return getStatus();
  }

  async function submitCode(code) {
    const normalized = typeof code === 'string' ? code.trim() : '';
    if (!normalized || normalized.length > 2048) throw new Error('A valid Claude login code is required');
    if (!activeChild || !state.verificationUri || state.phase !== 'awaiting') {
      throw new Error('No Claude login is waiting for a code');
    }
    activeChild.stdin.write(`${normalized}\n`);
    state = { ...state, phase: 'verifying', error: '' };
    return getStatus();
  }

  async function logout() {
    if (activeChild) stopActiveLogin();
    const runtime = await resolveRuntime();
    if (!runtime) return publicState({ available: false });
    const result = await runCommand(runtime.command, ['auth', 'logout'], {
      env: runtime.loginEnv,
      spawnProcess,
    });
    if (result.error || result.code !== 0) throw new Error(result.error?.message || 'Claude logout failed');
    state = { phase: 'idle', verificationUri: '', expiresAt: 0, error: '' };
    return getStatus();
  }

  return { getStatus, startLogin, submitCode, logout };
}

export const claudeAuthManager = createClaudeAuthManager();
