import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { open, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { createKeyedTaskQueue, ensureDir, readJson, removePath, writeTextAtomic } from '../chat/fs-utils.mjs';
import { CONFIG_DIR } from './config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

export const WECHAT_LOGIN_PAGE_PATH = '/connectors/wechat/login';
export const WECHAT_LOGIN_STATUS_PATH = '/api/connectors/wechat/login';
export const WECHAT_LOGIN_QR_PATH = '/api/connectors/wechat/login/qr';

export const WECHAT_CONNECTOR_DIR = join(CONFIG_DIR, 'wechat-connector');
export const WECHAT_CONNECTOR_CONFIG_PATH = join(WECHAT_CONNECTOR_DIR, 'config.json');
export const WECHAT_ACCOUNTS_PATH = join(WECHAT_CONNECTOR_DIR, 'accounts.json');
export const WECHAT_LOGIN_STATE_PATH = join(WECHAT_CONNECTOR_DIR, 'login-state.json');
export const WECHAT_LOGIN_PID_PATH = join(WECHAT_CONNECTOR_DIR, 'login.pid');
export const WECHAT_LOGIN_LOG_PATH = join(WECHAT_CONNECTOR_DIR, 'login-run.log');

const LOGIN_START_WAIT_TIMEOUT_MS = 5000;
const LOGIN_START_WAIT_INTERVAL_MS = 200;
const CONFIRMED_STATE_GRACE_MS = 15_000;
const loginStartQueue = createKeyedTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePid(value) {
  const pid = Number.parseInt(trimString(value), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWeChatAccountRecord(value, fallbackAccountId = '') {
  const accountId = trimString(value?.accountId || fallbackAccountId);
  const token = trimString(value?.token);
  if (!accountId || !token) return null;
  return {
    accountId,
    token,
    baseUrl: trimString(value?.baseUrl),
    userId: trimString(value?.userId),
    status: trimString(value?.status) || 'ready',
    lastError: trimString(value?.lastError),
    savedAt: trimString(value?.savedAt),
    lastLoginAt: trimString(value?.lastLoginAt),
  };
}

async function loadWeChatAccountsDocument() {
  const raw = await readJson(WECHAT_ACCOUNTS_PATH, {});
  const accounts = {};
  const rawAccounts = raw?.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
  for (const [accountId, record] of Object.entries(rawAccounts)) {
    const normalized = normalizeWeChatAccountRecord(record, accountId);
    if (!normalized) continue;
    accounts[normalized.accountId] = normalized;
  }
  return {
    defaultAccountId: trimString(raw?.defaultAccountId),
    accounts,
  };
}

function pickPrimaryLinkedAccount(accountsDocument) {
  const defaultAccountId = trimString(accountsDocument?.defaultAccountId);
  if (defaultAccountId && accountsDocument?.accounts?.[defaultAccountId]) {
    return accountsDocument.accounts[defaultAccountId];
  }
  for (const account of Object.values(accountsDocument?.accounts || {})) {
    if (account?.token) return account;
  }
  return null;
}

async function loadWeChatLoginState() {
  const raw = await readJson(WECHAT_LOGIN_STATE_PATH, null);
  if (!raw || typeof raw !== 'object') return null;
  return {
    status: trimString(raw.status).toLowerCase(),
    loginId: trimString(raw.loginId),
    qrcodeUrl: trimString(raw.qrcodeUrl),
    loginBaseUrl: trimString(raw.loginBaseUrl),
    pollBaseUrl: trimString(raw.pollBaseUrl),
    botType: trimString(raw.botType),
    accountId: trimString(raw.accountId),
    baseUrl: trimString(raw.baseUrl),
    userId: trimString(raw.userId),
    startedAt: trimString(raw.startedAt),
    confirmedAt: trimString(raw.confirmedAt),
    updatedAt: trimString(raw.updatedAt),
  };
}

function buildQrVersion(qrcodeUrl) {
  const normalized = trimString(qrcodeUrl);
  if (!normalized) return '';
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

function parseTimestamp(value) {
  const timestamp = Date.parse(trimString(value));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isRecentConfirmedState(loginState) {
  if (trimString(loginState?.status) !== 'confirmed') return false;
  const updatedAt = parseTimestamp(loginState?.updatedAt || loginState?.confirmedAt);
  if (!updatedAt) return false;
  return (Date.now() - updatedAt) < CONFIRMED_STATE_GRACE_MS;
}

async function readLiveLoginProcessId() {
  const pid = parsePid(await readFile(WECHAT_LOGIN_PID_PATH, 'utf8').catch(() => ''));
  if (pid && isProcessAlive(pid)) {
    return pid;
  }
  await removePath(WECHAT_LOGIN_PID_PATH);
  return 0;
}

async function spawnWeChatLoginProcess() {
  await ensureDir(WECHAT_CONNECTOR_DIR);
  const args = [
    join(PROJECT_ROOT, 'scripts', 'wechat-connector.mjs'),
    'login',
    '--config',
    WECHAT_CONNECTOR_CONFIG_PATH,
    '--force',
  ];
  const [stdoutHandle, stderrHandle] = await Promise.all([
    open(WECHAT_LOGIN_LOG_PATH, 'a'),
    open(WECHAT_LOGIN_LOG_PATH, 'a'),
  ]);
  try {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        REMOTELAB_CONFIG_DIR: CONFIG_DIR,
      },
      detached: true,
      stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
    });
    child.unref();
    await writeTextAtomic(WECHAT_LOGIN_PID_PATH, `${child.pid}\n`);
    return child.pid;
  } finally {
    await Promise.allSettled([
      stdoutHandle.close(),
      stderrHandle.close(),
    ]);
  }
}

async function waitForWeChatLoginBootstrap(timeoutMs = LOGIN_START_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [accountsDocument, loginState, loginPid] = await Promise.all([
      loadWeChatAccountsDocument(),
      loadWeChatLoginState(),
      readLiveLoginProcessId(),
    ]);
    const linkedAccount = pickPrimaryLinkedAccount(accountsDocument);
    if (linkedAccount || trimString(loginState?.qrcodeUrl) || loginPid) {
      return {
        linkedAccount,
        loginState,
        loginPid,
      };
    }
    await sleep(LOGIN_START_WAIT_INTERVAL_MS);
  }
  return {
    linkedAccount: pickPrimaryLinkedAccount(await loadWeChatAccountsDocument()),
    loginState: await loadWeChatLoginState(),
    loginPid: await readLiveLoginProcessId(),
  };
}

async function maybeStartWeChatLoginWorker() {
  return await loginStartQueue(WECHAT_LOGIN_PID_PATH, async () => {
    const [accountsDocument, loginState, loginPid] = await Promise.all([
      loadWeChatAccountsDocument(),
      loadWeChatLoginState(),
      readLiveLoginProcessId(),
    ]);
    const linkedAccount = pickPrimaryLinkedAccount(accountsDocument);
    if (linkedAccount || loginPid || isRecentConfirmedState(loginState)) {
      return {
        started: false,
        linkedAccount,
        loginState,
        loginPid,
      };
    }
    await removePath(WECHAT_LOGIN_STATE_PATH);
    const startedPid = await spawnWeChatLoginProcess();
    const bootstrapped = await waitForWeChatLoginBootstrap();
    return {
      started: true,
      linkedAccount: bootstrapped.linkedAccount,
      loginState: bootstrapped.loginState,
      loginPid: bootstrapped.loginPid || startedPid,
    };
  });
}

function describeLoginStatus({ linkedAccount, loginState, loginPid }) {
  if (linkedAccount) {
    return 'WeChat is connected for this workspace.';
  }

  const status = trimString(loginState?.status).toLowerCase();
  if (status === 'confirmed') {
    return 'WeChat confirmed. Finishing the binding...';
  }
  if (status === 'scaned_but_redirect') {
    return 'QR scanned. Waiting for WeChat confirmation...';
  }
  if (status === 'qr_refreshed') {
    return 'QR refreshed. Scan the latest code in WeChat.';
  }
  if (status === 'qr_ready' || status === 'wait') {
    return 'Scan the QR code with WeChat to connect.';
  }
  if (loginPid) {
    return 'Preparing a fresh WeChat QR code...';
  }
  return 'Preparing a fresh WeChat QR code...';
}

export async function getWeChatLoginSurface({
  autoStart = true,
  authPath = WECHAT_LOGIN_PAGE_PATH,
  qrPath = WECHAT_LOGIN_QR_PATH,
} = {}) {
  const [accountsDocument, initialLoginState, initialLoginPid] = await Promise.all([
    loadWeChatAccountsDocument(),
    loadWeChatLoginState(),
    readLiveLoginProcessId(),
  ]);
  let linkedAccount = pickPrimaryLinkedAccount(accountsDocument);
  let loginState = initialLoginState;
  let loginPid = initialLoginPid;
  let startedWorker = false;

  if (!linkedAccount && autoStart && !loginPid && !isRecentConfirmedState(loginState)) {
    const result = await maybeStartWeChatLoginWorker();
    startedWorker = result.started;
    linkedAccount = result.linkedAccount || linkedAccount;
    loginState = result.loginState || loginState;
    loginPid = result.loginPid || loginPid;
  }

  const qrcodeVersion = buildQrVersion(loginState?.qrcodeUrl);
  const status = linkedAccount
    ? 'connected'
    : (trimString(loginState?.status).toLowerCase() || (loginPid ? 'starting' : 'starting'));

  return {
    connectorId: 'wechat',
    capabilityState: linkedAccount ? 'ready' : 'authorization_required',
    message: describeLoginStatus({ linkedAccount, loginState, loginPid }),
    startedWorker,
    status,
    authPath,
    qrPath,
    loginRunning: !!loginPid,
    loginPid,
    qrcodeVersion,
    qrcodeUrlAvailable: !!trimString(loginState?.qrcodeUrl),
    qrcodeImagePath: qrcodeVersion
      ? `${qrPath}?v=${encodeURIComponent(qrcodeVersion)}`
      : qrPath,
    login: linkedAccount ? null : {
      status,
      startedAt: trimString(loginState?.startedAt),
      updatedAt: trimString(loginState?.updatedAt),
      confirmedAt: trimString(loginState?.confirmedAt),
      qrcodeVersion,
      requiresUserAction: true,
    },
    requiresUserAction: linkedAccount ? null : {
      kind: 'scan_qr',
      href: authPath,
    },
    account: linkedAccount ? {
      accountId: linkedAccount.accountId,
      userId: linkedAccount.userId,
      status: linkedAccount.status,
      lastLoginAt: linkedAccount.lastLoginAt,
      savedAt: linkedAccount.savedAt,
    } : null,
  };
}

export async function getWeChatLoginQrUrl({ autoStart = true } = {}) {
  const surface = await getWeChatLoginSurface({ autoStart });
  const loginState = await loadWeChatLoginState();
  return {
    surface,
    qrcodeUrl: trimString(loginState?.qrcodeUrl),
  };
}
