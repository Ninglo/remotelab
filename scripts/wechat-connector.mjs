#!/usr/bin/env node

import { readFileSync } from 'fs';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { randomBytes, randomUUID } from 'crypto';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { pathToFileURL } from 'url';

import { AUTH_FILE, CHAT_PORT, CONFIG_DIR } from '../lib/config.mjs';
import {
  normalizeExternalRuntimeSelectionMode,
  resolveExternalRuntimeSelection,
} from '../lib/external-runtime-selection.mjs';
import {
  buildAssistantReplyAttachmentFallbackText,
  selectAssistantReplyEvent,
  stripHiddenBlocks,
} from '../lib/reply-selection.mjs';
import { waitForReplyPublication } from '../lib/reply-publication-client.mjs';
import { loadUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import {
  buildConnectorFailureReply,
  decideConnectorUserVisibleReply,
} from '../lib/connector-user-visible-reply.mjs';
import {
  loadConnectorSurfaceTemplate,
  renderConnectorSurfaceTemplate,
  startConnectorSurfaceServer,
} from '../lib/connector-sdk/surface.mjs';
import { getWeChatLoginQrUrl, getWeChatLoginSurface } from '../lib/wechat-connector-login.mjs';

const DEFAULT_STORAGE_DIR = join(CONFIG_DIR, 'wechat-connector');
const DEFAULT_CONFIG_PATH = process.env.REMOTELAB_WECHAT_CONFIG_PATH
  ? resolve(process.env.REMOTELAB_WECHAT_CONFIG_PATH)
  : join(DEFAULT_STORAGE_DIR, 'config.json');
const DEFAULT_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
const DEFAULT_API_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_SESSION_TOOL = 'codex';
const DEFAULT_RUNTIME_SELECTION_MODE = 'ui';
const DEFAULT_SOURCE_NAME = 'WeChat';
const DEFAULT_GROUP = 'WeChat';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_STATUS_TIMEOUT_MS = 35_000;
const DEFAULT_LOGIN_WAIT_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_LOGIN_STATUS_POLL_INTERVAL_MS = 1000;
const DEFAULT_IDLE_DELAY_MS = 1000;
const DEFAULT_ERROR_DELAY_MS = 5000;
const DEFAULT_PROCESSING_ACK_DELAY_MS = 2000;
const DEFAULT_LOGIN_BOT_TYPE = '3';
const DEFAULT_SURFACE_HOST = '127.0.0.1';
const DEFAULT_SURFACE_TITLE = 'WeChat';
const DEFAULT_SURFACE_ENTRY_PATH = '/login';
const MAX_WECHAT_TEXT_LENGTH = 5000;
const MAX_LOGIN_QR_REFRESHES = 3;
const RUN_POLL_INTERVAL_MS = 1500;
const RUN_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const CONNECTOR_PID_FILENAME = 'connector.pid';
const REMOTELAB_SESSION_APP_ID = 'wechat';
const LEGACY_DEFAULT_SESSION_SYSTEM_PROMPT = [
  'You are replying through a WeChat bot powered by RemoteLab on the user\'s own machine.',
  'For each assistant turn, output exactly the plain-text message to send back to WeChat.',
  'Keep replies concise, helpful, and natural.',
  'Match the user\'s language when practical.',
  'Do not mention hidden connector, session, or run internals unless the user explicitly asks.',
].join('\n');
const DEFAULT_SESSION_SYSTEM_PROMPT = [
  'You are interacting through a WeChat connector on the user\'s own machine.',
  'Keep connector-specific overrides minimal and only describe constraints not already owned by RemoteLab backend prompt logic.',
].join('\n');
const WECHAT_LOGIN_QR_BASE_URL = 'https://ilinkai.weixin.qq.com';
const ILINK_APP_ID = 'bot';
const PACKAGE_VERSION = loadPackageVersion();
const ILINK_APP_CLIENT_VERSION = buildIlinkClientVersion(PACKAGE_VERSION);
const WECHAT_MESSAGE_TYPE = Object.freeze({
  USER: 1,
  BOT: 2,
});
const WECHAT_MESSAGE_STATE = Object.freeze({
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
});
const WECHAT_ITEM_TYPE = Object.freeze({
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
});

function loadPackageVersion() {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    return trimString(parsed?.version) || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function buildIlinkClientVersion(version) {
  const parts = String(version || '0.0.0')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeScalarString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value).trim();
  }
  return '';
}

function nowIso() {
  return new Date().toISOString();
}

function elapsedMs(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function truncateLogValue(value, maxLength = 120) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatLogFields(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      if (typeof value === 'number' || typeof value === 'boolean') {
        return `${key}=${value}`;
      }
      return `${key}=${JSON.stringify(truncateLogValue(value))}`;
    })
    .join(' ');
}

function logConnectorStage(stage, fields = {}) {
  const suffix = formatLogFields(fields);
  console.log(`[wechat-connector] ${stage}${suffix ? ` ${suffix}` : ''}`);
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = trimString(value).toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeBaseUrl(value, fallback = '') {
  const normalized = trimString(value || fallback).replace(/\/+$/, '');
  return normalized || trimString(fallback).replace(/\/+$/, '');
}

function normalizeWebPath(value, fallback = '/') {
  const normalized = `/${trimString(value || fallback).replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return normalized || '/';
}

function resolveHomePath(value, fallback = '') {
  const trimmed = trimString(value || fallback);
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function resolveOptionalPath(value, baseDir, fallbackPath) {
  const trimmed = trimString(value);
  if (!trimmed) return fallbackPath;
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return resolve(baseDir, trimmed);
  }
  return resolve(trimmed);
}

function defaultRuntimeSelectionPath(storageDir) {
  const normalizedStorageDir = resolveHomePath(storageDir, DEFAULT_STORAGE_DIR);
  const baseDir = basename(normalizedStorageDir) === 'wechat-connector'
    ? dirname(normalizedStorageDir)
    : normalizedStorageDir;
  return join(baseDir, 'ui-runtime-selection.json');
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sanitizeIdPart(value, fallback = 'unknown') {
  const normalized = trimString(value)
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function containsCjk(text) {
  return /[\u3400-\u9FFF]/u.test(String(text || ''));
}

function maskToken(token) {
  const normalized = trimString(token);
  if (!normalized) return '(none)';
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
}

function sortObjectKeys(value) {
  return Object.fromEntries(
    Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: 'base',
    })),
  );
}

function normalizeSystemPrompt(value) {
  const normalized = trimString(value);
  if (!normalized) return '';
  if (normalized === DEFAULT_SESSION_SYSTEM_PROMPT || normalized === LEGACY_DEFAULT_SESSION_SYSTEM_PROMPT) {
    return '';
  }
  return normalized;
}

function parseArgs(argv) {
  const options = {
    action: 'run',
    configPath: DEFAULT_CONFIG_PATH,
    accountId: '',
    sessionId: '',
    peerUserId: '',
    contextToken: '',
    text: '',
    durationMs: 0,
    replayLast: false,
    force: false,
  };

  let index = 0;
  if (argv[0] && !argv[0].startsWith('-')) {
    options.action = trimString(argv[0]).toLowerCase();
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      options.configPath = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--account') {
      options.accountId = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--session') {
      options.sessionId = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--peer-user') {
      options.peerUserId = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--context-token') {
      options.contextToken = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--text') {
      options.text = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--duration-ms') {
      options.durationMs = parsePositiveInteger(argv[index + 1], 0);
      index += 1;
      continue;
    }
    if (arg === '--replay-last') {
      options.replayLast = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      printUsage(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const validActions = new Set(['run', 'login', 'status', 'list-accounts', 'logout', 'send', 'send-session']);
  if (!validActions.has(options.action)) {
    throw new Error(`Unsupported action: ${options.action}`);
  }
  if (!options.configPath) {
    throw new Error('Missing config path');
  }
  return options;
}

function printUsage(exitCode) {
  const output = exitCode === 0 ? console.log : console.error;
  output(`Usage:
  node scripts/wechat-connector.mjs [run] [options]
  node scripts/wechat-connector.mjs login [options]
  node scripts/wechat-connector.mjs status [options]
  node scripts/wechat-connector.mjs list-accounts [options]
  node scripts/wechat-connector.mjs send --peer-user <id> --text <text> [options]
  node scripts/wechat-connector.mjs send-session --session <id> --text <text> [options]
  node scripts/wechat-connector.mjs logout [--account <id>] [options]

Options:
  --config <path>        Config file path (default: ${DEFAULT_CONFIG_PATH})
  --account <id>         Restrict worker/logout to one linked account
  --session <id>         RemoteLab session id for send-session
  --peer-user <id>       WeChat peer user id for direct send
  --context-token <tok>  Optional WeChat context token override for direct send
  --text <text>          Direct-send text payload
  --duration-ms <ms>     Optional smoke-test duration before exit
  --replay-last          Reprocess the latest stored inbound text message once
  --force                For login: overwrite stale QR state; for run: include reauth-required accounts
  -h, --help             Show this help

Config shape:
  {
    "storageDir": "~/.config/remotelab/wechat-connector",
    "chatBaseUrl": "${DEFAULT_CHAT_BASE_URL}",
    "apiBaseUrl": "${DEFAULT_API_BASE_URL}",
    "sessionFolder": "${homedir()}",
    "runtimeSelectionMode": "${DEFAULT_RUNTIME_SELECTION_MODE}",
    "runtimeSelectionPath": "${join(dirname(DEFAULT_STORAGE_DIR), 'ui-runtime-selection.json')}",
    "sessionTool": "${DEFAULT_SESSION_TOOL}",
    "model": "",
    "effort": "",
    "thinking": false,
    "systemPrompt": "${DEFAULT_SESSION_SYSTEM_PROMPT.replace(/"/g, '\\"')}",
    "activeAccountId": "",
    "silentConfirmationText": "",
    "processingAckText": "",
    "processingAckDelayMs": ${DEFAULT_PROCESSING_ACK_DELAY_MS},
    "login": {
      "qrBaseUrl": "${WECHAT_LOGIN_QR_BASE_URL}",
      "botType": "${DEFAULT_LOGIN_BOT_TYPE}",
      "waitTimeoutMs": ${DEFAULT_LOGIN_WAIT_TIMEOUT_MS}
    },
    "polling": {
      "timeoutMs": ${DEFAULT_LONG_POLL_TIMEOUT_MS},
      "idleDelayMs": ${DEFAULT_IDLE_DELAY_MS},
      "errorDelayMs": ${DEFAULT_ERROR_DELAY_MS}
    },
    "surface": {
      "enabled": true,
      "host": "${DEFAULT_SURFACE_HOST}",
      "port": 0,
      "title": "${DEFAULT_SURFACE_TITLE}",
      "entryPath": "${DEFAULT_SURFACE_ENTRY_PATH}",
      "loginPageTemplatePath": ""
    }
  }
`);
  process.exit(exitCode);
}

function normalizeConfig(value, options = {}) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const resolvedConfigPath = resolveHomePath(options.configPath || DEFAULT_CONFIG_PATH, DEFAULT_CONFIG_PATH);
  const storageDir = resolveHomePath(normalized.storageDir || dirname(resolvedConfigPath), DEFAULT_STORAGE_DIR);
  const hasCustomSystemPrompt = Object.prototype.hasOwnProperty.call(normalized, 'systemPrompt');

  const storagePaths = {
    accountsPath: resolveOptionalPath(
      normalized.accountsPath,
      storageDir,
      join(storageDir, 'accounts.json'),
    ),
    syncStatePath: resolveOptionalPath(
      normalized.syncStatePath,
      storageDir,
      join(storageDir, 'sync-state.json'),
    ),
    contextTokensPath: resolveOptionalPath(
      normalized.contextTokensPath,
      storageDir,
      join(storageDir, 'context-tokens.json'),
    ),
    loginStatePath: resolveOptionalPath(
      normalized.loginStatePath,
      storageDir,
      join(storageDir, 'login-state.json'),
    ),
    eventsLogPath: resolveOptionalPath(
      normalized.eventsLogPath,
      storageDir,
      join(storageDir, 'events.jsonl'),
    ),
    handledMessagesPath: resolveOptionalPath(
      normalized.handledMessagesPath,
      storageDir,
      join(storageDir, 'handled-messages.json'),
    ),
  };

  return {
    configPath: resolvedConfigPath,
    storageDir,
    storagePaths,
    chatBaseUrl: normalizeBaseUrl(normalized.chatBaseUrl, DEFAULT_CHAT_BASE_URL),
    apiBaseUrl: normalizeBaseUrl(normalized.apiBaseUrl, DEFAULT_API_BASE_URL),
    sessionFolder: resolveHomePath(normalized.sessionFolder || homedir(), homedir()),
    runtimeSelectionMode: normalizeExternalRuntimeSelectionMode(
      normalized.runtimeSelectionMode,
      DEFAULT_RUNTIME_SELECTION_MODE,
    ),
    runtimeSelectionPath: resolveOptionalPath(
      normalized.runtimeSelectionPath,
      dirname(resolvedConfigPath),
      defaultRuntimeSelectionPath(storageDir),
    ),
    sessionTool: trimString(normalized.sessionTool || DEFAULT_SESSION_TOOL) || DEFAULT_SESSION_TOOL,
    model: trimString(normalized.model),
    effort: trimString(normalized.effort),
    thinking: normalizeBoolean(normalized.thinking, false),
    systemPrompt: hasCustomSystemPrompt ? normalizeSystemPrompt(normalized.systemPrompt) : '',
    sourceName: trimString(normalized.sourceName || DEFAULT_SOURCE_NAME) || DEFAULT_SOURCE_NAME,
    group: trimString(normalized.group || DEFAULT_GROUP) || DEFAULT_GROUP,
    activeAccountId: trimString(normalized.activeAccountId),
    silentConfirmationText: trimString(normalized.silentConfirmationText),
    processingAckText: trimString(normalized.processingAckText),
    processingAckDelayMs: parseNonNegativeInteger(
      normalized.processingAckDelayMs,
      DEFAULT_PROCESSING_ACK_DELAY_MS,
    ),
    login: {
      qrBaseUrl: normalizeBaseUrl(normalized.login?.qrBaseUrl, WECHAT_LOGIN_QR_BASE_URL),
      botType: trimString(normalized.login?.botType || DEFAULT_LOGIN_BOT_TYPE) || DEFAULT_LOGIN_BOT_TYPE,
      waitTimeoutMs: parsePositiveInteger(normalized.login?.waitTimeoutMs, DEFAULT_LOGIN_WAIT_TIMEOUT_MS),
      statusPollIntervalMs: parsePositiveInteger(
        normalized.login?.statusPollIntervalMs,
        DEFAULT_LOGIN_STATUS_POLL_INTERVAL_MS,
      ),
      statusTimeoutMs: parsePositiveInteger(
        normalized.login?.statusTimeoutMs,
        DEFAULT_LOGIN_STATUS_TIMEOUT_MS,
      ),
    },
    polling: {
      timeoutMs: parsePositiveInteger(normalized.polling?.timeoutMs, DEFAULT_LONG_POLL_TIMEOUT_MS),
      idleDelayMs: parsePositiveInteger(normalized.polling?.idleDelayMs, DEFAULT_IDLE_DELAY_MS),
      errorDelayMs: parsePositiveInteger(normalized.polling?.errorDelayMs, DEFAULT_ERROR_DELAY_MS),
    },
    surface: {
      enabled: normalizeBoolean(normalized.surface?.enabled, true),
      host: trimString(normalized.surface?.host || DEFAULT_SURFACE_HOST) || DEFAULT_SURFACE_HOST,
      port: parseNonNegativeInteger(normalized.surface?.port, 0),
      title: trimString(normalized.surface?.title || DEFAULT_SURFACE_TITLE) || DEFAULT_SURFACE_TITLE,
      entryPath: normalizeWebPath(normalized.surface?.entryPath, DEFAULT_SURFACE_ENTRY_PATH),
      loginPageTemplatePath: resolveOptionalPath(
        normalized.surface?.loginPageTemplatePath,
        dirname(resolvedConfigPath),
        '',
      ),
    },
  };
}

async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const resolvedPath = resolveHomePath(configPath, DEFAULT_CONFIG_PATH);
  let raw = '';
  try {
    raw = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return normalizeConfig({}, { configPath: resolvedPath });
    }
    throw error;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${resolvedPath}: ${error?.message || error}`);
  }
  return normalizeConfig(parsed, { configPath: resolvedPath });
}

async function ensureDir(pathname) {
  await mkdir(pathname, { recursive: true });
}

async function appendJsonl(pathname, value) {
  await ensureDir(dirname(pathname));
  await appendFile(pathname, `${JSON.stringify(value)}\n`, 'utf8');
}

async function readJson(pathname, fallback) {
  try {
    return JSON.parse(await readFile(pathname, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(pathname, value) {
  await ensureDir(dirname(pathname));
  const tempPath = `${pathname}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, pathname);
}

function normalizeAccountRecord(value, fallbackAccountId = '') {
  const accountId = trimString(value?.accountId || fallbackAccountId);
  if (!accountId) return null;
  const token = trimString(value?.token);
  return {
    accountId,
    token,
    baseUrl: normalizeBaseUrl(value?.baseUrl, DEFAULT_API_BASE_URL) || DEFAULT_API_BASE_URL,
    userId: trimString(value?.userId),
    status: trimString(value?.status) || (token ? 'ready' : 'missing_token'),
    lastError: trimString(value?.lastError),
    savedAt: trimString(value?.savedAt),
    lastLoginAt: trimString(value?.lastLoginAt),
  };
}

function normalizeAccountsDocument(value) {
  const accounts = {};
  if (value && typeof value === 'object' && !Array.isArray(value) && value.accounts && typeof value.accounts === 'object') {
    for (const [accountId, record] of Object.entries(value.accounts)) {
      const normalized = normalizeAccountRecord(record, accountId);
      if (!normalized) continue;
      accounts[normalized.accountId] = normalized;
    }
  }
  const defaultAccountId = trimString(value?.defaultAccountId);
  return {
    defaultAccountId: accounts[defaultAccountId]
      ? defaultAccountId
      : (Object.keys(accounts)[0] || ''),
    accounts: sortObjectKeys(accounts),
  };
}

function snapshotAccountsDocument(document) {
  const normalized = normalizeAccountsDocument(document);
  const snapshot = {
    defaultAccountId: normalized.defaultAccountId,
    accounts: {},
  };
  for (const [accountId, record] of Object.entries(normalized.accounts)) {
    snapshot.accounts[accountId] = sortObjectKeys({
      accountId,
      token: trimString(record.token),
      baseUrl: normalizeBaseUrl(record.baseUrl, DEFAULT_API_BASE_URL),
      userId: trimString(record.userId),
      status: trimString(record.status),
      lastError: trimString(record.lastError),
      savedAt: trimString(record.savedAt),
      lastLoginAt: trimString(record.lastLoginAt),
    });
  }
  return snapshot;
}

async function loadAccountsDocument(pathname) {
  return normalizeAccountsDocument(await readJson(pathname, {}));
}

async function saveAccountsDocument(pathname, document) {
  await writeJsonAtomic(pathname, snapshotAccountsDocument(document));
}

function normalizeSyncStateDocument(value) {
  const accounts = {};
  if (value && typeof value === 'object' && !Array.isArray(value) && value.accounts && typeof value.accounts === 'object') {
    for (const [accountId, record] of Object.entries(value.accounts)) {
      const normalizedAccountId = trimString(accountId);
      if (!normalizedAccountId) continue;
      accounts[normalizedAccountId] = {
        getUpdatesBuf: trimString(record?.getUpdatesBuf || record?.get_updates_buf),
        longPollTimeoutMs: parsePositiveInteger(record?.longPollTimeoutMs, 0),
        updatedAt: trimString(record?.updatedAt),
      };
    }
  }
  return { accounts: sortObjectKeys(accounts) };
}

function snapshotSyncStateDocument(document) {
  const normalized = normalizeSyncStateDocument(document);
  const snapshot = { accounts: {} };
  for (const [accountId, record] of Object.entries(normalized.accounts)) {
    snapshot.accounts[accountId] = sortObjectKeys({
      getUpdatesBuf: trimString(record.getUpdatesBuf),
      longPollTimeoutMs: parsePositiveInteger(record.longPollTimeoutMs, 0),
      updatedAt: trimString(record.updatedAt),
    });
  }
  return snapshot;
}

async function loadSyncStateDocument(pathname) {
  return normalizeSyncStateDocument(await readJson(pathname, {}));
}

async function saveSyncStateDocument(pathname, document) {
  await writeJsonAtomic(pathname, snapshotSyncStateDocument(document));
}

function updateSyncCursor(document, accountId, values = {}) {
  const next = normalizeSyncStateDocument(document);
  const normalizedAccountId = trimString(accountId);
  if (!normalizedAccountId) return next;
  next.accounts[normalizedAccountId] = {
    getUpdatesBuf: trimString(values.getUpdatesBuf ?? values.get_updates_buf),
    longPollTimeoutMs: parsePositiveInteger(values.longPollTimeoutMs, 0),
    updatedAt: trimString(values.updatedAt) || nowIso(),
  };
  next.accounts = sortObjectKeys(next.accounts);
  return next;
}

function normalizeContextTokensDocument(value) {
  const accounts = {};
  if (value && typeof value === 'object' && !Array.isArray(value) && value.accounts && typeof value.accounts === 'object') {
    for (const [accountId, peers] of Object.entries(value.accounts)) {
      const normalizedAccountId = trimString(accountId);
      if (!normalizedAccountId || !peers || typeof peers !== 'object' || Array.isArray(peers)) continue;
      const normalizedPeers = {};
      for (const [peerUserId, entry] of Object.entries(peers)) {
        const normalizedPeerUserId = trimString(peerUserId);
        const token = trimString(entry?.token || entry);
        if (!normalizedPeerUserId || !token) continue;
        normalizedPeers[normalizedPeerUserId] = {
          token,
          updatedAt: trimString(entry?.updatedAt),
        };
      }
      if (Object.keys(normalizedPeers).length > 0) {
        accounts[normalizedAccountId] = sortObjectKeys(normalizedPeers);
      }
    }
  }
  return { accounts: sortObjectKeys(accounts) };
}

function snapshotContextTokensDocument(document) {
  const normalized = normalizeContextTokensDocument(document);
  const snapshot = { accounts: {} };
  for (const [accountId, peers] of Object.entries(normalized.accounts)) {
    snapshot.accounts[accountId] = {};
    for (const [peerUserId, entry] of Object.entries(peers)) {
      snapshot.accounts[accountId][peerUserId] = sortObjectKeys({
        token: trimString(entry.token),
        updatedAt: trimString(entry.updatedAt),
      });
    }
  }
  return snapshot;
}

async function loadContextTokensDocument(pathname) {
  return normalizeContextTokensDocument(await readJson(pathname, {}));
}

async function saveContextTokensDocument(pathname, document) {
  await writeJsonAtomic(pathname, snapshotContextTokensDocument(document));
}

function setStoredContextToken(document, accountId, peerUserId, token) {
  const normalizedAccountId = trimString(accountId);
  const normalizedPeerUserId = trimString(peerUserId);
  const normalizedToken = trimString(token);
  const next = normalizeContextTokensDocument(document);
  if (!normalizedAccountId || !normalizedPeerUserId || !normalizedToken) return next;
  if (!next.accounts[normalizedAccountId]) {
    next.accounts[normalizedAccountId] = {};
  }
  next.accounts[normalizedAccountId][normalizedPeerUserId] = {
    token: normalizedToken,
    updatedAt: nowIso(),
  };
  next.accounts[normalizedAccountId] = sortObjectKeys(next.accounts[normalizedAccountId]);
  next.accounts = sortObjectKeys(next.accounts);
  return next;
}

function getStoredContextToken(document, accountId, peerUserId) {
  return trimString(document?.accounts?.[trimString(accountId)]?.[trimString(peerUserId)]?.token);
}

function removeAccountContextTokens(document, accountId) {
  const normalizedAccountId = trimString(accountId);
  const next = normalizeContextTokensDocument(document);
  if (!normalizedAccountId) return next;
  delete next.accounts[normalizedAccountId];
  next.accounts = sortObjectKeys(next.accounts);
  return next;
}

function removeAccountSyncState(document, accountId) {
  const normalizedAccountId = trimString(accountId);
  const next = normalizeSyncStateDocument(document);
  if (!normalizedAccountId) return next;
  delete next.accounts[normalizedAccountId];
  next.accounts = sortObjectKeys(next.accounts);
  return next;
}

async function loadHandledMessages(pathname) {
  return await readJson(pathname, { messages: {} });
}

async function wasMessageHandled(pathname, messageKey) {
  const state = await loadHandledMessages(pathname);
  return Boolean(state?.messages?.[messageKey]);
}

async function markMessageHandled(pathname, messageKey, metadata) {
  const state = await loadHandledMessages(pathname);
  state.messages[messageKey] = {
    ...(state.messages[messageKey] || {}),
    ...metadata,
    handledAt: metadata?.handledAt || nowIso(),
  };
  await writeJsonAtomic(pathname, state);
}

async function removeAccountHandledMessages(pathname, accountId) {
  const normalizedAccountId = trimString(accountId);
  if (!normalizedAccountId) return;
  const state = await loadHandledMessages(pathname);
  const prefix = `${normalizedAccountId}:`;
  for (const key of Object.keys(state?.messages || {})) {
    if (key.startsWith(prefix)) {
      delete state.messages[key];
    }
  }
  await writeJsonAtomic(pathname, state);
}

async function saveLoginState(pathname, state) {
  await writeJsonAtomic(pathname, sortObjectKeys({
    ...state,
    updatedAt: nowIso(),
  }));
}

async function clearLoginState(pathname) {
  try {
    await rm(pathname, { force: true });
  } catch {}
}

function buildDefaultSurfaceLoginTemplate() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>{{TITLE}}</title>
  <style nonce="{{NONCE}}">
    :root {
      color-scheme: light;
      --page: #f3efe7;
      --card: rgba(255, 250, 244, 0.94);
      --border: rgba(67, 54, 41, 0.14);
      --text: #241c16;
      --muted: #6f6254;
      --accent: #0f7a45;
      --accent-soft: rgba(15, 122, 69, 0.12);
      --ok: #0f7a45;
      --ok-soft: rgba(15, 122, 69, 0.12);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --page: #181713;
        --card: rgba(31, 28, 25, 0.94);
        --border: rgba(255, 237, 211, 0.08);
        --text: #f6ede0;
        --muted: #b9ac9b;
        --accent: #49c87d;
        --accent-soft: rgba(73, 200, 125, 0.14);
        --ok: #49c87d;
        --ok-soft: rgba(73, 200, 125, 0.14);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      font-family: "SF Pro Display", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(15, 122, 69, 0.10), transparent 26%),
        radial-gradient(circle at bottom right, rgba(204, 146, 70, 0.12), transparent 22%),
        var(--page);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 20px;
    }
    .shell {
      width: min(100%, 440px);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 24px;
      overflow: hidden;
    }
    .hero { padding: 24px 24px 12px; }
    .eyebrow {
      display: inline-flex;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    h1 {
      margin: 14px 0 8px;
      font-size: 30px;
      line-height: 1.04;
      letter-spacing: -0.04em;
    }
    .intro, .status-note, .qr-stage, .meta {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
    }
    .status-row { padding: 18px 24px 0; }
    .status-pill {
      display: inline-flex;
      border-radius: 999px;
      padding: 8px 12px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 13px;
      font-weight: 700;
    }
    .status-pill.ready {
      background: var(--ok-soft);
      color: var(--ok);
    }
    .qr-wrap { padding: 18px 24px 24px; }
    .qr-panel {
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 18px;
    }
    .qr-stage { margin-bottom: 14px; }
    .qr-frame {
      min-height: 280px;
      border-radius: 18px;
      display: grid;
      place-items: center;
      background: rgba(255, 255, 255, 0.7);
      padding: 18px;
    }
    .qr-image {
      width: min(100%, 260px);
      height: auto;
      display: block;
      border-radius: 14px;
      background: white;
    }
    .qr-empty {
      text-align: center;
      max-width: 220px;
      color: #695f56;
      font-size: 14px;
      line-height: 1.5;
    }
    .actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin-top: 14px;
      flex-wrap: wrap;
    }
    .link {
      color: var(--accent);
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
    }
    .success {
      display: none;
      margin-top: 14px;
      padding: 16px;
      border-radius: 18px;
      background: var(--ok-soft);
      color: var(--ok);
    }
    .success strong {
      display: block;
      font-size: 15px;
      margin-bottom: 6px;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="hero">
      <div class="eyebrow">{{TITLE}}</div>
      <h1>Connect This Workspace</h1>
      <p class="intro">Keep this page open. If the QR code expires, the connector will refresh it automatically behind the same link.</p>
    </div>
    <div class="status-row">
      <div class="status-pill" id="status-pill">Preparing</div>
      <div class="status-note" id="status-note">Preparing a fresh QR code...</div>
    </div>
    <div class="qr-wrap">
      <div class="qr-panel">
        <div class="qr-stage" id="qr-stage">Open WeChat and scan the code below.</div>
        <div class="qr-frame">
          <img id="qr-image" class="qr-image hidden" alt="WeChat login QR code">
          <div id="qr-empty" class="qr-empty">Generating a fresh QR code. This usually takes a moment.</div>
        </div>
        <div class="actions">
          <a id="qr-link" class="link hidden" href="#" target="_blank" rel="noreferrer">Open QR image</a>
          <div class="meta" id="meta-text"></div>
        </div>
        <div id="success-panel" class="success">
          <strong>WeChat connected.</strong>
          <span id="success-text">This workspace is ready to receive WeChat messages.</span>
        </div>
      </div>
    </div>
  </div>
  <script nonce="{{NONCE}}">
    (function() {
      var statusEndpoint = '{{STATUS_PATH}}';
      var qrEndpoint = '{{QR_PATH}}';
      var statusPill = document.getElementById('status-pill');
      var statusNote = document.getElementById('status-note');
      var qrStage = document.getElementById('qr-stage');
      var qrImage = document.getElementById('qr-image');
      var qrEmpty = document.getElementById('qr-empty');
      var qrLink = document.getElementById('qr-link');
      var metaText = document.getElementById('meta-text');
      var successPanel = document.getElementById('success-panel');
      var successText = document.getElementById('success-text');
      var currentQrVersion = '';
      var inFlight = false;

      function stageLabel(status) {
        if (status === 'connected') return 'Connected';
        if (status === 'confirmed') return 'Confirming';
        if (status === 'scaned_but_redirect') return 'Scanned';
        if (status === 'qr_refreshed') return 'Refreshed';
        if (status === 'qr_ready' || status === 'wait') return 'Ready To Scan';
        return 'Preparing';
      }

      function stageBody(status) {
        if (status === 'connected') return 'WeChat is now connected for this workspace.';
        if (status === 'confirmed') return 'WeChat confirmed the scan. Finishing the binding.';
        if (status === 'scaned_but_redirect') return 'Scan received. Please confirm inside WeChat if prompted.';
        if (status === 'qr_refreshed') return 'The old code expired. Scan the refreshed code below.';
        if (status === 'qr_ready' || status === 'wait') return 'Open WeChat and scan the QR code below.';
        return 'Preparing a fresh QR code...';
      }

      function updateQrImage(version) {
        if (!version) return;
        if (version !== currentQrVersion) {
          currentQrVersion = version;
          var src = qrEndpoint + '?v=' + encodeURIComponent(version);
          qrImage.src = src;
          qrLink.href = src;
        }
        qrImage.classList.remove('hidden');
        qrLink.classList.remove('hidden');
        qrEmpty.classList.add('hidden');
      }

      function showWaitingState() {
        qrImage.classList.add('hidden');
        qrLink.classList.add('hidden');
        qrEmpty.classList.remove('hidden');
      }

      function applyState(state) {
        if (!state || typeof state !== 'object') return;
        var status = String(state.status || (state.login && state.login.status) || '');
        var isReady = state.capabilityState === 'ready';
        statusPill.textContent = stageLabel(status);
        statusPill.classList.toggle('ready', isReady);
        statusNote.textContent = String(state.message || stageBody(status));
        qrStage.textContent = stageBody(status);
        metaText.textContent = state.login && state.login.updatedAt ? 'Updated ' + state.login.updatedAt : '';
        if (isReady) {
          successPanel.style.display = 'block';
          successText.textContent = state.account && state.account.userId
            ? 'Bound to ' + state.account.userId
            : 'This workspace is ready to receive WeChat messages.';
          showWaitingState();
          return;
        }
        successPanel.style.display = 'none';
        if (state.qrcodeVersion) {
          updateQrImage(state.qrcodeVersion);
        } else {
          showWaitingState();
        }
      }

      async function refreshState() {
        if (inFlight) return;
        inFlight = true;
        try {
          var response = await fetch(statusEndpoint, { cache: 'no-store', headers: { 'Accept': 'application/json' } });
          if (!response.ok) throw new Error('status ' + response.status);
          applyState(await response.json());
        } catch {
          statusPill.textContent = 'Retrying';
          statusPill.classList.remove('ready');
          statusNote.textContent = 'Retrying connector status...';
        } finally {
          inFlight = false;
        }
      }

      qrImage.addEventListener('error', function() {
        currentQrVersion = '';
        showWaitingState();
      });

      refreshState();
      window.setInterval(refreshState, 2000);
    })();
  </script>
</body>
</html>`;
}

async function startWeChatSurfaceServer(runtime) {
  if (runtime.config?.surface?.enabled === false) {
    return {
      baseUrl: '',
      stop: async () => {},
    };
  }

  const host = trimString(runtime.config?.surface?.host || DEFAULT_SURFACE_HOST) || DEFAULT_SURFACE_HOST;
  const requestedPort = parseNonNegativeInteger(runtime.config?.surface?.port, 0);
  const title = trimString(runtime.config?.surface?.title || DEFAULT_SURFACE_TITLE) || DEFAULT_SURFACE_TITLE;
  const entryPath = normalizeWebPath(runtime.config?.surface?.entryPath, DEFAULT_SURFACE_ENTRY_PATH);
  const template = await loadConnectorSurfaceTemplate({
    templatePath: runtime.config?.surface?.loginPageTemplatePath,
    fallbackTemplate: buildDefaultSurfaceLoginTemplate,
    logLabel: 'wechat-connector',
  });

  return await startConnectorSurfaceServer({
    connectorId: 'wechat',
    title,
    host,
    port: requestedPort,
    entryPath,
    allowEmbed: true,
    describeSurface: async ({ mountPrefix }) => ({
      surfaceType: 'login',
      description: 'Scan in WeChat to connect this workspace. The QR code refreshes behind one stable link.',
      embed: {
        mode: 'iframe',
        sameOrigin: true,
      },
      surface: await getWeChatLoginSurface({
        autoStart: false,
        authPath: `${mountPrefix}${entryPath}`,
        qrPath: `${mountPrefix}${entryPath}/qr`,
      }),
    }),
    handleRequest: async ({ req, res, url, mountPrefix, nonce, sendJson }) => {
      const statusPath = `${mountPrefix}${entryPath}/status`;
      const qrPath = `${mountPrefix}${entryPath}/qr`;

      if (req.method === 'GET' && url.pathname === entryPath) {
        const body = renderConnectorSurfaceTemplate(template, {
          NONCE: nonce,
          TITLE: title,
          STATUS_PATH: statusPath,
          QR_PATH: qrPath,
        });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        });
        res.end(body);
        return true;
      }

      if (req.method === 'GET' && url.pathname === `${entryPath}/status`) {
        const surface = await getWeChatLoginSurface({
          autoStart: true,
          authPath: `${mountPrefix}${entryPath}`,
          qrPath,
        });
        sendJson(res, 200, surface);
        return true;
      }

      if (req.method === 'GET' && url.pathname === `${entryPath}/qr`) {
        const { surface, qrcodeUrl } = await getWeChatLoginQrUrl({ autoStart: true });
        if (surface?.capabilityState === 'ready') {
          res.writeHead(409, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, max-age=0, must-revalidate',
          });
          res.end('WeChat is already connected.');
          return true;
        }
        if (!qrcodeUrl) {
          res.writeHead(503, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, max-age=0, must-revalidate',
          });
          res.end('WeChat QR code is not ready yet.');
          return true;
        }
        try {
          const response = await fetch(qrcodeUrl);
          if (!response.ok) {
            throw new Error(`QR upstream ${response.status}`);
          }
          const contentType = trimString(response.headers.get('content-type')) || 'image/png';
          const body = Buffer.from(await response.arrayBuffer());
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': String(body.length),
            'Cache-Control': 'no-store, max-age=0, must-revalidate',
          });
          res.end(body);
        } catch (error) {
          res.writeHead(502, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, max-age=0, must-revalidate',
          });
          res.end(`Failed to load WeChat QR image: ${error?.message || 'unknown error'}`);
        }
        return true;
      }

      return false;
    },
  });
}

function buildBaseInfo() {
  return { channel_version: PACKAGE_VERSION };
}

function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

function buildIlinkCommonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
}

function buildIlinkHeaders({ token, body }) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildIlinkCommonHeaders(),
  };
  if (trimString(token)) {
    headers.Authorization = `Bearer ${trimString(token)}`;
  }
  return headers;
}

async function apiGetFetch({ baseUrl, endpoint, timeoutMs, label }) {
  const url = new URL(endpoint, `${normalizeBaseUrl(baseUrl)}/`);
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: buildIlinkCommonHeaders(),
      signal: controller?.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`${label} ${response.status}: ${rawText}`);
    }
    return rawText;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function apiPostFetch({
  baseUrl,
  endpoint,
  body,
  token = '',
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  label,
}) {
  const url = new URL(endpoint, `${normalizeBaseUrl(baseUrl)}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: buildIlinkHeaders({ token, body }),
      body,
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`${label} ${response.status}: ${rawText}`);
    }
    return rawText;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLoginQr(baseUrl, botType = DEFAULT_LOGIN_BOT_TYPE) {
  const rawText = await apiGetFetch({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    label: 'fetchLoginQr',
  });
  return JSON.parse(rawText);
}

async function pollLoginStatus(baseUrl, qrcode, timeoutMs = DEFAULT_LOGIN_STATUS_TIMEOUT_MS) {
  try {
    const rawText = await apiGetFetch({
      baseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs,
      label: 'pollLoginStatus',
    });
    return JSON.parse(rawText);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'wait' };
    }
    return { status: 'wait', networkError: error?.message || String(error) };
  }
}

async function getUpdates({
  baseUrl,
  token,
  getUpdatesBuf = '',
  timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
}) {
  try {
    const rawText = await apiPostFetch({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: buildBaseInfo(),
      }),
      token,
      timeoutMs,
      label: 'getUpdates',
    });
    return JSON.parse(rawText);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: getUpdatesBuf,
      };
    }
    throw error;
  }
}

async function sendMessage({
  baseUrl,
  token,
  payload,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const rawText = await apiPostFetch({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({
      ...payload,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs,
    label: 'sendMessage',
  });
  if (!trimString(rawText)) return {};
  const parsed = JSON.parse(rawText);
  if (Number.isInteger(parsed?.ret) && parsed.ret !== 0) {
    throw new Error(parsed?.errmsg || `sendMessage failed (${parsed.ret})`);
  }
  return parsed;
}

function resolveRedirectBaseUrl(redirectHost, currentBaseUrl) {
  const normalizedHost = trimString(redirectHost);
  if (!normalizedHost) return normalizeBaseUrl(currentBaseUrl, currentBaseUrl);
  if (/^https?:\/\//i.test(normalizedHost)) {
    return normalizeBaseUrl(normalizedHost, normalizedHost);
  }
  try {
    const current = new URL(normalizeBaseUrl(currentBaseUrl, currentBaseUrl));
    return `${current.protocol}//${normalizedHost}`.replace(/\/+$/, '');
  } catch {
    return `https://${normalizedHost}`;
  }
}

async function renderLoginQr(url) {
  try {
    const qrcode = await import('qrcode-terminal');
    if (qrcode?.default?.generate) {
      qrcode.default.generate(url, { small: true });
      return true;
    }
  } catch {}
  return false;
}

async function startWeChatLogin(config, helpers = {}) {
  const fetchQr = helpers.fetchLoginQr || fetchLoginQr;
  const qrBaseUrl = normalizeBaseUrl(helpers.qrBaseUrl, config?.login?.qrBaseUrl || WECHAT_LOGIN_QR_BASE_URL);
  const botType = trimString(helpers.botType || config?.login?.botType || DEFAULT_LOGIN_BOT_TYPE) || DEFAULT_LOGIN_BOT_TYPE;
  const qr = await fetchQr(qrBaseUrl, botType);
  const session = {
    loginId: randomUUID(),
    loginBaseUrl: qrBaseUrl,
    pollBaseUrl: qrBaseUrl,
    botType,
    qrcode: trimString(qr?.qrcode),
    qrcodeUrl: trimString(qr?.qrcode_img_content || qr?.qrcodeUrl),
    startedAt: nowIso(),
  };
  if (!session.qrcode || !session.qrcodeUrl) {
    throw new Error('WeChat login QR response did not include qrcode/qrcodeUrl');
  }
  if (config?.storagePaths?.loginStatePath) {
    await saveLoginState(config.storagePaths.loginStatePath, {
      status: 'qr_ready',
      loginId: session.loginId,
      qrcodeUrl: session.qrcodeUrl,
      loginBaseUrl: session.loginBaseUrl,
      pollBaseUrl: session.pollBaseUrl,
      botType: session.botType,
      startedAt: session.startedAt,
    });
  }
  return session;
}

async function waitForWeChatLogin(config, session, helpers = {}) {
  const poll = helpers.pollLoginStatus || pollLoginStatus;
  const fetchQr = helpers.fetchLoginQr || fetchLoginQr;
  const displayQr = helpers.displayQr || renderLoginQr;
  const timeoutMs = parsePositiveInteger(
    helpers.timeoutMs,
    config?.login?.waitTimeoutMs || DEFAULT_LOGIN_WAIT_TIMEOUT_MS,
  );
  const statusTimeoutMs = parsePositiveInteger(
    helpers.statusTimeoutMs,
    config?.login?.statusTimeoutMs || DEFAULT_LOGIN_STATUS_TIMEOUT_MS,
  );
  const pollIntervalMs = parsePositiveInteger(
    helpers.statusPollIntervalMs,
    config?.login?.statusPollIntervalMs || DEFAULT_LOGIN_STATUS_POLL_INTERVAL_MS,
  );

  const deadline = Date.now() + timeoutMs;
  let pollBaseUrl = normalizeBaseUrl(session?.pollBaseUrl, session?.loginBaseUrl || config?.login?.qrBaseUrl || WECHAT_LOGIN_QR_BASE_URL);
  let refreshCount = 0;

  while (Date.now() < deadline) {
    const status = await poll(pollBaseUrl, session.qrcode, statusTimeoutMs);
    const normalizedStatus = trimString(status?.status).toLowerCase() || 'wait';

    if (config?.storagePaths?.loginStatePath) {
      await saveLoginState(config.storagePaths.loginStatePath, {
        status: normalizedStatus,
        loginId: session.loginId,
        qrcodeUrl: session.qrcodeUrl,
        pollBaseUrl,
        loginBaseUrl: session.loginBaseUrl,
        botType: session.botType,
        startedAt: session.startedAt,
      });
    }

    if (normalizedStatus === 'confirmed') {
      const result = {
        connected: true,
        accountId: trimString(status?.ilink_bot_id),
        botToken: trimString(status?.bot_token),
        baseUrl: normalizeBaseUrl(status?.baseurl, config?.apiBaseUrl || DEFAULT_API_BASE_URL),
        userId: trimString(status?.ilink_user_id),
        message: 'WeChat login confirmed.',
      };
      if (!result.accountId || !result.botToken) {
        throw new Error('WeChat login confirmation did not include accountId/botToken');
      }
      if (config?.storagePaths?.loginStatePath) {
        await saveLoginState(config.storagePaths.loginStatePath, {
          status: 'confirmed',
          loginId: session.loginId,
          accountId: result.accountId,
          baseUrl: result.baseUrl,
          userId: result.userId,
          confirmedAt: nowIso(),
        });
      }
      return result;
    }

    if (normalizedStatus === 'scaned_but_redirect') {
      pollBaseUrl = resolveRedirectBaseUrl(status?.redirect_host, pollBaseUrl);
      await delay(pollIntervalMs);
      continue;
    }

    if (normalizedStatus === 'expired') {
      refreshCount += 1;
      if (refreshCount > MAX_LOGIN_QR_REFRESHES) {
        return {
          connected: false,
          message: 'WeChat login QR expired too many times. Please retry.',
        };
      }

      const nextQr = await fetchQr(session.loginBaseUrl || config?.login?.qrBaseUrl || WECHAT_LOGIN_QR_BASE_URL, session.botType || DEFAULT_LOGIN_BOT_TYPE);
      session.qrcode = trimString(nextQr?.qrcode);
      session.qrcodeUrl = trimString(nextQr?.qrcode_img_content || nextQr?.qrcodeUrl);
      session.startedAt = nowIso();
      pollBaseUrl = session.loginBaseUrl || config?.login?.qrBaseUrl || WECHAT_LOGIN_QR_BASE_URL;
      if (session.qrcodeUrl) {
        await displayQr(session.qrcodeUrl);
      }
      if (config?.storagePaths?.loginStatePath) {
        await saveLoginState(config.storagePaths.loginStatePath, {
          status: 'qr_refreshed',
          loginId: session.loginId,
          qrcodeUrl: session.qrcodeUrl,
          pollBaseUrl,
          loginBaseUrl: session.loginBaseUrl,
          botType: session.botType,
          startedAt: session.startedAt,
        });
      }
      await delay(pollIntervalMs);
      continue;
    }

    await delay(pollIntervalMs);
  }

  return {
    connected: false,
    message: 'WeChat login timed out.',
  };
}

async function persistLinkedAccount(config, result) {
  const accountsDoc = await loadAccountsDocument(config.storagePaths.accountsPath);
  const syncDoc = await loadSyncStateDocument(config.storagePaths.syncStatePath);
  const contextDoc = await loadContextTokensDocument(config.storagePaths.contextTokensPath);
  const handledPath = config.storagePaths.handledMessagesPath;

  for (const [accountId, record] of Object.entries(accountsDoc.accounts)) {
    if (accountId === result.accountId) continue;
    if (!result.userId || trimString(record.userId) !== result.userId) continue;
    delete accountsDoc.accounts[accountId];
    const nextSyncDoc = removeAccountSyncState(syncDoc, accountId);
    syncDoc.accounts = nextSyncDoc.accounts;
    const nextContextDoc = removeAccountContextTokens(contextDoc, accountId);
    contextDoc.accounts = nextContextDoc.accounts;
    await removeAccountHandledMessages(handledPath, accountId);
  }

  accountsDoc.accounts[result.accountId] = normalizeAccountRecord({
    accountId: result.accountId,
    token: result.botToken,
    baseUrl: result.baseUrl || config.apiBaseUrl,
    userId: result.userId,
    status: 'ready',
    lastError: '',
    savedAt: nowIso(),
    lastLoginAt: nowIso(),
  }, result.accountId);
  accountsDoc.defaultAccountId = result.accountId;
  accountsDoc.accounts = sortObjectKeys(accountsDoc.accounts);

  await saveAccountsDocument(config.storagePaths.accountsPath, accountsDoc);
  await saveSyncStateDocument(config.storagePaths.syncStatePath, syncDoc);
  await saveContextTokensDocument(config.storagePaths.contextTokensPath, contextDoc);
}

async function logoutWeChatAccount(config, accountId = '') {
  const accountsDoc = await loadAccountsDocument(config.storagePaths.accountsPath);
  const targetAccountId = trimString(accountId)
    || trimString(config.activeAccountId)
    || trimString(accountsDoc.defaultAccountId)
    || Object.keys(accountsDoc.accounts)[0]
    || '';
  if (!targetAccountId || !accountsDoc.accounts[targetAccountId]) {
    throw new Error('No linked WeChat account found to remove.');
  }

  delete accountsDoc.accounts[targetAccountId];
  if (accountsDoc.defaultAccountId === targetAccountId) {
    accountsDoc.defaultAccountId = Object.keys(accountsDoc.accounts)[0] || '';
  }
  await saveAccountsDocument(config.storagePaths.accountsPath, accountsDoc);
  await saveSyncStateDocument(
    config.storagePaths.syncStatePath,
    removeAccountSyncState(await loadSyncStateDocument(config.storagePaths.syncStatePath), targetAccountId),
  );
  await saveContextTokensDocument(
    config.storagePaths.contextTokensPath,
    removeAccountContextTokens(await loadContextTokensDocument(config.storagePaths.contextTokensPath), targetAccountId),
  );
  await removeAccountHandledMessages(config.storagePaths.handledMessagesPath, targetAccountId);
  console.log(`[wechat-connector] removed linked account ${targetAccountId}`);
}

function buildHandledMessageKey(summary) {
  return `${sanitizeIdPart(summary.accountId || 'account')}:${sanitizeIdPart(summary.messageId || 'message')}`;
}

function itemTypeLabel(type) {
  const numeric = Number.parseInt(String(type || ''), 10);
  if (numeric === WECHAT_ITEM_TYPE.TEXT) return 'text';
  if (numeric === WECHAT_ITEM_TYPE.IMAGE) return 'image';
  if (numeric === WECHAT_ITEM_TYPE.VOICE) return 'voice';
  if (numeric === WECHAT_ITEM_TYPE.FILE) return 'file';
  if (numeric === WECHAT_ITEM_TYPE.VIDEO) return 'video';
  return 'unknown';
}

function bodyFromItemList(itemList = []) {
  if (!Array.isArray(itemList)) return '';
  for (const item of itemList) {
    if (Number(item?.type) !== WECHAT_ITEM_TYPE.TEXT || typeof item?.text_item?.text !== 'string') {
      continue;
    }
    const text = trimString(item.text_item.text);
    if (!text) continue;
    const ref = item?.ref_msg;
    if (!ref) return text;

    const referenceParts = [];
    const refTitle = trimString(ref?.title);
    if (refTitle) referenceParts.push(refTitle);

    const refMessage = ref?.message_item;
    const refText = refMessage ? bodyFromItemList([refMessage]) : '';
    if (refText) {
      referenceParts.push(refText);
    } else if (refMessage && Number(refMessage?.type) !== WECHAT_ITEM_TYPE.TEXT) {
      referenceParts.push(itemTypeLabel(refMessage.type));
    }

    if (referenceParts.length === 0) return text;
    return `[quoted: ${referenceParts.join(' | ')}]\n${text}`;
  }
  return '';
}

function summarizeItemTypes(itemList = []) {
  const labels = [...new Set(
    (Array.isArray(itemList) ? itemList : [])
      .map((item) => itemTypeLabel(item?.type))
      .filter(Boolean),
  )];
  if (labels.length === 0) return '[empty message]';
  if (labels.length === 1) return `[${labels[0]} message]`;
  return `[${labels.join(' + ')} message]`;
}

function resolvePeerUserId(rawMessage) {
  return trimString(rawMessage?.from_user_id) || trimString(rawMessage?.to_user_id);
}

function summarizeWeChatMessage(rawMessage, account = {}) {
  const itemList = Array.isArray(rawMessage?.item_list) ? rawMessage.item_list : [];
  const messageTypeNumeric = Number.parseInt(String(rawMessage?.message_type || ''), 10) || 0;
  const messageStateNumeric = Number.parseInt(String(rawMessage?.message_state || ''), 10);
  const textPreview = bodyFromItemList(itemList);
  const peerUserId = resolvePeerUserId(rawMessage);
  return {
    accountId: trimString(account.accountId),
    accountUserId: trimString(account.userId),
    peerUserId,
    fromUserId: trimString(rawMessage?.from_user_id),
    toUserId: trimString(rawMessage?.to_user_id),
    messageId: normalizeScalarString(rawMessage?.message_id),
    seq: Number.isInteger(rawMessage?.seq) ? rawMessage.seq : undefined,
    createTimeMs: Number.isInteger(rawMessage?.create_time_ms) ? rawMessage.create_time_ms : undefined,
    sessionId: normalizeScalarString(rawMessage?.session_id),
    groupId: normalizeScalarString(rawMessage?.group_id),
    messageTypeNumeric,
    messageStateNumeric,
    messageType: messageTypeNumeric === WECHAT_MESSAGE_TYPE.USER
      ? 'user'
      : (messageTypeNumeric === WECHAT_MESSAGE_TYPE.BOT ? 'bot' : 'unknown'),
    messageState: messageStateNumeric === WECHAT_MESSAGE_STATE.FINISH
      ? 'finish'
      : (messageStateNumeric === WECHAT_MESSAGE_STATE.GENERATING
        ? 'generating'
        : (messageStateNumeric === WECHAT_MESSAGE_STATE.NEW ? 'new' : 'unknown')),
    itemTypes: [...new Set(itemList.map((item) => itemTypeLabel(item?.type)).filter(Boolean))],
    textPreview,
    contentSummary: textPreview || summarizeItemTypes(itemList),
    contextToken: trimString(rawMessage?.context_token),
  };
}

function redactLoggedRawMessage(rawMessage = {}) {
  const next = JSON.parse(JSON.stringify(rawMessage || {}));
  if (typeof next.context_token === 'string' && next.context_token) {
    next.context_token = '[redacted]';
  }
  return next;
}

function isProcessableMessage(summary) {
  if (!summary?.messageId || !summary?.accountId || !summary?.peerUserId) return false;
  const messageTypeNumeric = Number.isInteger(summary.messageTypeNumeric)
    ? summary.messageTypeNumeric
    : (trimString(summary.messageType).toLowerCase() === 'user' ? WECHAT_MESSAGE_TYPE.USER : 0);
  const messageStateNumeric = Number.isInteger(summary.messageStateNumeric)
    ? summary.messageStateNumeric
    : (trimString(summary.messageState).toLowerCase() === 'generating' ? WECHAT_MESSAGE_STATE.GENERATING : 0);
  if (messageTypeNumeric !== WECHAT_MESSAGE_TYPE.USER) return false;
  if (messageStateNumeric === WECHAT_MESSAGE_STATE.GENERATING) return false;
  return true;
}

function buildExternalTriggerId(summary) {
  return `${REMOTELAB_SESSION_APP_ID}:${sanitizeIdPart(summary.accountId || 'account')}:${sanitizeIdPart(summary.peerUserId || 'peer')}`;
}

function buildRequestId(summary) {
  return `${REMOTELAB_SESSION_APP_ID}:${sanitizeIdPart(summary.accountId || 'account')}:${sanitizeIdPart(summary.messageId || `${Date.now()}`)}`;
}

function buildSessionName(summary) {
  return trimString(summary?.sessionName);
}

function buildSessionDescription(summary) {
  const parts = ['Inbound WeChat direct chat'];
  const accountId = trimString(summary?.accountId);
  if (accountId) parts.push(`account ${accountId}`);
  return parts.join(' · ');
}

function buildRemoteLabMessage(summary) {
  return trimString(summary?.textPreview || summary?.contentSummary);
}

function buildSessionSourceContext(summary) {
  return sortObjectKeys({
    connector: 'wechat',
    chatType: 'direct',
    accountId: trimString(summary?.accountId),
    peerUserId: trimString(summary?.peerUserId),
    accountUserId: trimString(summary?.accountUserId),
  });
}

function buildMessageSourceContext(summary) {
  const context = {
    connector: 'wechat',
    messageId: trimString(summary?.messageId),
    chatType: 'direct',
    accountId: trimString(summary?.accountId),
    peerUserId: trimString(summary?.peerUserId),
  };
  const contentSummary = trimString(summary?.contentSummary);
  if (contentSummary) {
    context.contentSummary = contentSummary;
  }
  return sortObjectKeys(context);
}

async function readOwnerToken() {
  const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  const token = trimString(auth?.token);
  if (!token) {
    throw new Error(`No owner token found in ${AUTH_FILE}`);
  }
  return token;
}

async function loginWithToken(baseUrl, token) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 302 || !setCookie) {
    throw new Error(`Failed to authenticate to RemoteLab at ${baseUrl} (status ${response.status})`);
  }
  return setCookie.split(';')[0];
}

async function requestJson(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = {
    Accept: 'application/json',
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  return { response, json, text };
}

async function loadAssistantReply(requester, sessionId, runId, requestId) {
  const visitedSessionIds = new Set();

  function findRequestEventSeq(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event || event.role !== 'user' || event.type !== 'message') {
        continue;
      }
      if ((runId && event.runId === runId) || (requestId && event.requestId === requestId)) {
        return Number.isInteger(event.seq) ? event.seq : -1;
      }
    }
    return -1;
  }

  function findRedirectedSessionId(events, afterSeq) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event || event.role !== 'assistant' || event.type !== 'message') {
        continue;
      }
      if (event.messageKind !== 'session_continuation_notice') {
        continue;
      }
      if (Number.isInteger(afterSeq) && Number.isInteger(event.seq) && event.seq <= afterSeq) {
        continue;
      }
      const match = trimString(event.content).match(/[?&]session=([a-z0-9_-]+)/i);
      const redirectedSessionId = trimString(match?.[1]);
      if (redirectedSessionId) {
        return redirectedSessionId;
      }
    }
    return '';
  }

  async function loadReplyFromSession(targetSessionId) {
    if (!targetSessionId || visitedSessionIds.has(targetSessionId)) {
      return null;
    }
    visitedSessionIds.add(targetSessionId);

    const eventsResult = await requester(`/api/sessions/${targetSessionId}/events`);
    if (!eventsResult.response.ok || !Array.isArray(eventsResult.json?.events)) {
      throw new Error(eventsResult.json?.error || eventsResult.text || `Failed to load session events for ${targetSessionId}`);
    }
    const events = eventsResult.json.events;

    const candidate = await selectAssistantReplyEvent(events, {
      match: (event) => (
        (runId && event.runId === runId)
        || (requestId && event.requestId === requestId)
      ),
      hydrate: async (event) => {
        const bodyResult = await requester(`/api/sessions/${targetSessionId}/events/${event.seq}/body`);
        if (!bodyResult.response.ok || bodyResult.json?.body?.value === undefined) {
          return event;
        }
        return {
          ...event,
          content: bodyResult.json.body.value,
          bodyLoaded: true,
        };
      },
    });
    if (candidate) {
      return candidate;
    }

    const redirectedSessionId = findRedirectedSessionId(events, findRequestEventSeq(events));
    if (!redirectedSessionId) {
      return null;
    }
    return loadReplyFromSession(redirectedSessionId);
  }

  return loadReplyFromSession(sessionId);
}

function normalizeReplyText(text) {
  const normalized = stripHiddenBlocks(String(text || '').replace(/\r\n/g, '\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return '';
  if (normalized.length <= MAX_WECHAT_TEXT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_WECHAT_TEXT_LENGTH - 16).trimEnd()}\n\n[truncated]`;
}

function buildFailureReply(summary, reason = '') {
  return buildConnectorFailureReply(summary, reason);
}

function buildProcessingAck(summary, configuredText = '') {
  const normalizedConfiguredText = normalizeReplyText(configuredText);
  if (normalizedConfiguredText) {
    return normalizedConfiguredText;
  }
  const prefersChinese = containsCjk(`${summary?.textPreview || ''}\n${summary?.contentSummary || ''}`);
  if (prefersChinese) {
    return '已收到，正在处理。';
  }
  return 'Received. I am working on it.';
}

function createRuntimeContext(config, documents = {}) {
  return {
    config,
    storagePaths: config.storagePaths,
    accountsDoc: normalizeAccountsDocument(documents.accountsDoc || {}),
    syncStateDoc: normalizeSyncStateDocument(documents.syncStateDoc || {}),
    contextTokensDoc: normalizeContextTokensDocument(documents.contextTokensDoc || {}),
    processingMessageIds: new Set(),
    chatQueues: new Map(),
    authToken: '',
    authCookie: '',
  };
}

async function reloadRuntimeState(runtime, options = {}) {
  const refreshAccounts = options.accounts !== false;
  const refreshSyncState = options.syncState === true;
  const refreshContextTokens = options.contextTokens === true;

  if (refreshAccounts) {
    runtime.accountsDoc = await loadAccountsDocument(runtime.storagePaths.accountsPath);
  }
  if (refreshSyncState) {
    runtime.syncStateDoc = await loadSyncStateDocument(runtime.storagePaths.syncStatePath);
  }
  if (refreshContextTokens) {
    runtime.contextTokensDoc = await loadContextTokensDocument(runtime.storagePaths.contextTokensPath);
  }
  return runtime;
}

function enqueueByChat(runtime, summary, worker) {
  const key = buildExternalTriggerId(summary);
  const previous = runtime.chatQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(worker)
    .catch((error) => {
      console.error(`[wechat-connector] queued processing failed for ${summary.messageId || key}:`, error?.stack || error);
    });
  runtime.chatQueues.set(key, next);
  next.finally(() => {
    if (runtime.chatQueues.get(key) === next) {
      runtime.chatQueues.delete(key);
    }
  });
}

async function ensureAuthCookie(runtime, forceRefresh = false) {
  if (!forceRefresh && runtime.authCookie) {
    return runtime.authCookie;
  }
  if (forceRefresh) {
    runtime.authCookie = '';
    runtime.authToken = '';
  }
  if (!runtime.authToken) {
    runtime.authToken = typeof runtime.readOwnerToken === 'function'
      ? await runtime.readOwnerToken()
      : await readOwnerToken();
  }
  const login = typeof runtime.loginWithToken === 'function' ? runtime.loginWithToken : loginWithToken;
  runtime.authCookie = await login(runtime.config.chatBaseUrl, runtime.authToken);
  return runtime.authCookie;
}

async function requestRemoteLab(runtime, path, options = {}) {
  const cookie = await ensureAuthCookie(runtime, false);
  let result = await requestJson(runtime.config.chatBaseUrl, path, { ...options, cookie });
  if ([401, 403].includes(result.response.status)) {
    const refreshedCookie = await ensureAuthCookie(runtime, true);
    result = await requestJson(runtime.config.chatBaseUrl, path, { ...options, cookie: refreshedCookie });
  }
  return result;
}

async function loadRemoteLabSession(runtime, sessionId) {
  const result = await requestRemoteLab(runtime, `/api/sessions/${sessionId}`);
  if (!result.response.ok || !result.json?.session) {
    throw new Error(result.json?.error || result.text || `Failed to load session ${sessionId}`);
  }
  return result.json.session;
}

async function loadRemoteLabSourceContext(runtime, sessionId) {
  const result = await requestRemoteLab(runtime, `/api/sessions/${encodeURIComponent(sessionId)}/source-context`);
  if (!result.response.ok || !result.json?.sourceContext) {
    throw new Error(result.json?.error || result.text || `Failed to load source context for session ${sessionId}`);
  }
  return result.json.sourceContext;
}

function resolveSendAccountId(runtime, preferredAccountId = '') {
  const accounts = runtime.accountsDoc?.accounts || {};
  const resolved = trimString(preferredAccountId)
    || trimString(runtime.config.activeAccountId)
    || trimString(runtime.accountsDoc?.defaultAccountId)
    || Object.keys(accounts)[0]
    || '';
  if (!resolved || !accounts[resolved]) {
    throw new Error('No linked WeChat account is available for direct send');
  }
  return resolved;
}

function getRemoteLabSessionQueueCount(session) {
  return Number.isInteger(session?.activity?.queue?.count) ? session.activity.queue.count : 0;
}

function isRemoteLabSessionBusy(session) {
  return trimString(session?.activity?.run?.state).toLowerCase() === 'running'
    || trimString(session?.activity?.compact?.state).toLowerCase() === 'pending'
    || getRemoteLabSessionQueueCount(session) > 0;
}

async function waitForSessionReady(runtime, sessionId, initialSession = null) {
  const deadline = Date.now() + RUN_POLL_TIMEOUT_MS;
  let session = initialSession
    && initialSession.id === sessionId
    && initialSession.activity
    ? initialSession
    : null;
  while (Date.now() < deadline) {
    if (!session) {
      session = await loadRemoteLabSession(runtime, sessionId);
    }
    if (!isRemoteLabSessionBusy(session)) {
      return session;
    }
    await delay(RUN_POLL_INTERVAL_MS);
    session = null;
  }
  throw new Error(`session ${sessionId} remained busy after ${RUN_POLL_TIMEOUT_MS}ms`);
}

async function createOrReuseSession(runtime, summary, runtimeSelection) {
  const payload = {
    folder: runtime.config.sessionFolder,
    tool: runtimeSelection.tool,
    name: buildSessionName(summary),
    sourceId: REMOTELAB_SESSION_APP_ID,
    sourceName: runtime.config.sourceName,
    group: runtime.config.group,
    description: buildSessionDescription(summary),
    systemPrompt: runtime.config.systemPrompt,
    externalTriggerId: buildExternalTriggerId(summary),
    sourceContext: buildSessionSourceContext(summary),
  };
  const result = await requestRemoteLab(runtime, '/api/sessions', {
    method: 'POST',
    body: payload,
  });
  if (!result.response.ok || !result.json?.session?.id) {
    throw new Error(result.json?.error || result.text || `Failed to create session (${result.response.status})`);
  }
  return result.json.session;
}

async function submitRemoteLabMessage(runtime, sessionId, summary, runtimeSelection) {
  const payload = {
    requestId: buildRequestId(summary),
    text: buildRemoteLabMessage(summary),
    tool: runtimeSelection.tool,
    sourceContext: buildMessageSourceContext(summary),
  };
  if (runtimeSelection.thinking) payload.thinking = true;
  if (runtimeSelection.model) payload.model = runtimeSelection.model;
  if (runtimeSelection.effort) payload.effort = runtimeSelection.effort;

  const result = await requestRemoteLab(runtime, `/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: payload,
  });
  const duplicate = result.json?.duplicate === true;
  const runId = trimString(result.json?.run?.id);
  const queued = result.json?.queued === true;
  const responseId = trimString(result.json?.response?.id) || payload.requestId;
  if (queued && !runId && !duplicate) {
    throw new Error('RemoteLab queued the WeChat request; expected an immediate run');
  }
  if (![200, 202].includes(result.response.status)) {
    throw new Error(result.json?.error || result.text || `Failed to submit session message (${result.response.status})`);
  }

  return {
    requestId: payload.requestId,
    responseId,
    runId: runId || null,
    duplicate,
    queued,
  };
}

async function resolveWeChatRuntimeSelection(runtime) {
  const uiSelection = await loadUiRuntimeSelection(runtime?.config?.runtimeSelectionPath);
  return resolveExternalRuntimeSelection({
    uiSelection,
    mode: runtime?.config?.runtimeSelectionMode || DEFAULT_RUNTIME_SELECTION_MODE,
    fallback: {
      tool: runtime?.config?.sessionTool || DEFAULT_SESSION_TOOL,
      model: runtime?.config?.model || '',
      effort: runtime?.config?.effort || '',
      thinking: runtime?.config?.thinking === true,
    },
    defaultTool: DEFAULT_SESSION_TOOL,
  });
}

async function generateRemoteLabReply(runtime, summary) {
  const pipelineStartedAt = Date.now();
  const runtimeSelection = await resolveWeChatRuntimeSelection(runtime);
  logConnectorStage('runtime selected', {
    messageId: summary.messageId,
    tool: runtimeSelection.tool,
    model: runtimeSelection.model,
    effort: runtimeSelection.effort,
    thinking: runtimeSelection.thinking === true,
  });

  const sessionStartedAt = Date.now();
  const session = await createOrReuseSession(runtime, summary, runtimeSelection);
  const readySession = await waitForSessionReady(runtime, session.id, session);
  const baselineSeq = Number.isInteger(readySession?.latestSeq) ? readySession.latestSeq : 0;
  const sessionMs = elapsedMs(sessionStartedAt);
  logConnectorStage('session ready', {
    messageId: summary.messageId,
    sessionId: session.id,
    latestSeq: baselineSeq,
    sessionMs,
  });

  const submitStartedAt = Date.now();
  const submission = await submitRemoteLabMessage(runtime, session.id, summary, runtimeSelection);
  const submitMs = elapsedMs(submitStartedAt);
  logConnectorStage('message submitted', {
    messageId: summary.messageId,
    sessionId: session.id,
    requestId: submission.requestId,
    runId: submission.runId || '',
    duplicate: submission.duplicate,
    submitMs,
  });

  const runId = submission.runId;
  const responseId = submission.responseId;
  const publicationStartedAt = Date.now();
  const publication = await waitForReplyPublication(
    (path) => requestRemoteLab(runtime, path),
    session.id,
    responseId,
    {
      timeoutMs: RUN_POLL_TIMEOUT_MS,
      intervalMs: RUN_POLL_INTERVAL_MS,
    },
  );
  const publicationMs = elapsedMs(publicationStartedAt);
  logConnectorStage('reply publication settled', {
    messageId: summary.messageId,
    sessionId: session.id,
    responseId,
    state: publication.state,
    publicationMs,
  });
  if (publication.state !== 'ready') {
    throw new Error(`reply publication ${publication.state || 'failed'}`);
  }

  const replyLoadStartedAt = Date.now();
  const finalizedRunId = trimString(publication.finalRunId) || runId || '';
  let replyText = normalizeReplyText(publication.payload?.text || '');
  if (!replyText) {
    const replyEvent = await loadAssistantReply(
      (path) => requestRemoteLab(runtime, path),
      session.id,
      finalizedRunId,
      submission.requestId,
    );
    replyText = normalizeReplyText(replyEvent?.content);
  }
  const replyLoadMs = elapsedMs(replyLoadStartedAt);
  const totalMs = elapsedMs(pipelineStartedAt);
  logConnectorStage('reply loaded', {
    messageId: summary.messageId,
    sessionId: session.id,
    runId: finalizedRunId,
    replyChars: replyText.length,
    replyLoadMs,
    totalMs,
  });
  return {
    sessionId: session.id,
    runId: finalizedRunId,
    requestId: submission.requestId,
    duplicate: submission.duplicate,
    replyText,
    silent: !replyText,
    timingMs: {
      total: totalMs,
      session: sessionMs,
      submit: submitMs,
      run: publicationMs,
      replyLoad: replyLoadMs,
    },
  };
}

function buildOutboundClientId() {
  return `remotelab-wechat-${randomBytes(8).toString('hex')}`;
}

async function sendWeChatText(runtime, summary, text) {
  const account = runtime.accountsDoc.accounts?.[summary.accountId];
  if (!account || !trimString(account.token)) {
    throw new Error(`No linked WeChat token found for account ${summary.accountId}`);
  }
  const contextToken = trimString(summary.contextToken)
    || getStoredContextToken(runtime.contextTokensDoc, summary.accountId, summary.peerUserId);
  const clientId = buildOutboundClientId();

  await sendMessage({
    baseUrl: account.baseUrl || runtime.config.apiBaseUrl,
    token: account.token,
    payload: {
      msg: {
        from_user_id: '',
        to_user_id: summary.peerUserId,
        client_id: clientId,
        message_type: WECHAT_MESSAGE_TYPE.BOT,
        message_state: WECHAT_MESSAGE_STATE.FINISH,
        context_token: contextToken || undefined,
        item_list: [{
          type: WECHAT_ITEM_TYPE.TEXT,
          text_item: { text },
        }],
      },
    },
  });

  return { message_id: clientId };
}

async function sendDirectWeChatText(runtime, {
  accountId = '',
  peerUserId = '',
  contextToken = '',
  text = '',
  sessionId = '',
} = {}) {
  await reloadRuntimeState(runtime, {
    accounts: true,
    contextTokens: true,
  });

  const resolvedAccountId = resolveSendAccountId(runtime, accountId);
  const normalizedPeerUserId = trimString(peerUserId);
  const normalizedText = trimString(text);
  if (!normalizedPeerUserId) {
    throw new Error('Direct WeChat send requires --peer-user or a source-bound session');
  }
  if (!normalizedText) {
    throw new Error('Direct WeChat send requires --text');
  }

  const result = await sendWeChatText(runtime, {
    accountId: resolvedAccountId,
    peerUserId: normalizedPeerUserId,
    contextToken: trimString(contextToken),
  }, normalizedText);

  logConnectorStage('direct message sent', {
    sessionId: trimString(sessionId),
    accountId: resolvedAccountId,
    peerUserId: normalizedPeerUserId,
    responseMessageId: result?.message_id || '',
    textChars: normalizedText.length,
  });
  return result;
}

async function sendDirectWeChatTextForSession(runtime, sessionId, text) {
  const normalizedSessionId = trimString(sessionId);
  if (!normalizedSessionId) {
    throw new Error('send-session requires --session');
  }
  const sourceContext = await loadRemoteLabSourceContext(runtime, normalizedSessionId);
  const connector = trimString(sourceContext?.session?.connector || sourceContext?.message?.connector).toLowerCase();
  if (connector !== 'wechat') {
    throw new Error(`Session ${normalizedSessionId} is not bound to WeChat`);
  }

  return sendDirectWeChatText(runtime, {
    accountId: trimString(sourceContext?.session?.accountId || sourceContext?.message?.accountId),
    peerUserId: trimString(sourceContext?.session?.peerUserId || sourceContext?.message?.peerUserId),
    text,
    sessionId: normalizedSessionId,
  });
}

async function recordInboundEvent(runtime, summary, rawMessage, sourceLabel = 'getupdates') {
  await appendJsonl(runtime.storagePaths.eventsLogPath, {
    sourceLabel,
    receivedAt: nowIso(),
    summary: {
      accountId: summary.accountId,
      peerUserId: summary.peerUserId,
      accountUserId: summary.accountUserId,
      messageId: summary.messageId,
      seq: summary.seq,
      createTimeMs: summary.createTimeMs,
      messageType: summary.messageType,
      messageTypeNumeric: summary.messageTypeNumeric,
      messageState: summary.messageState,
      messageStateNumeric: summary.messageStateNumeric,
      textPreview: summary.textPreview,
      contentSummary: summary.contentSummary,
      itemTypes: summary.itemTypes,
    },
    raw: redactLoggedRawMessage(rawMessage),
  });
}

async function loadLatestReplayableSummary(eventsLogPath) {
  try {
    const raw = await readFile(eventsLogPath, 'utf8');
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed?.summary?.accountId || !parsed?.summary?.peerUserId || !parsed?.summary?.messageId) {
        continue;
      }
      return parsed.summary;
    }
  } catch {}
  return null;
}

async function loadReplayableSummaries(eventsLogPath, handledMessagesPath, { accountIds = [] } = {}) {
  const allowedAccountIds = new Set(
    (Array.isArray(accountIds) ? accountIds : [])
      .map((value) => trimString(value))
      .filter(Boolean),
  );
  const seenMessageKeys = new Set();
  const replayable = [];
  let handledMessages = { messages: {} };
  try {
    handledMessages = await loadHandledMessages(handledMessagesPath);
  } catch {}
  const handledMessageKeys = new Set(Object.keys(handledMessages?.messages || {}));

  try {
    const raw = await readFile(eventsLogPath, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(trimmedLine);
      } catch {
        continue;
      }
      if (trimString(parsed?.sourceLabel) !== 'getupdates') {
        continue;
      }
      const summary = parsed?.summary && typeof parsed.summary === 'object'
        ? parsed.summary
        : null;
      if (!summary || !isProcessableMessage(summary)) {
        continue;
      }
      if (allowedAccountIds.size > 0 && !allowedAccountIds.has(trimString(summary.accountId))) {
        continue;
      }
      const messageKey = buildHandledMessageKey(summary);
      if (seenMessageKeys.has(messageKey) || handledMessageKeys.has(messageKey)) {
        continue;
      }
      seenMessageKeys.add(messageKey);
      replayable.push(summary);
    }
  } catch {}

  return replayable;
}

async function replayUnhandledMessages(runtime, {
  accountIds = [],
  handleWeChatMessageImpl = handleWeChatMessage,
} = {}) {
  const summaries = await loadReplayableSummaries(
    runtime.storagePaths.eventsLogPath,
    runtime.storagePaths.handledMessagesPath,
    { accountIds },
  );
  let replayedCount = 0;
  for (const summary of summaries) {
    const accountId = trimString(summary?.accountId);
    if (!trimString(runtime.accountsDoc?.accounts?.[accountId]?.token)) {
      continue;
    }
    const augmentedSummary = {
      ...summary,
      contextToken: getStoredContextToken(runtime.contextTokensDoc, summary.accountId, summary.peerUserId),
    };
    console.log(`[wechat-connector] replaying stored message ${augmentedSummary.messageId}`);
    await handleWeChatMessageImpl(runtime, augmentedSummary);
    replayedCount += 1;
  }
  return replayedCount;
}

async function persistContextToken(runtime, summary) {
  const token = trimString(summary?.contextToken);
  if (!token) return;
  runtime.contextTokensDoc = setStoredContextToken(
    runtime.contextTokensDoc,
    summary.accountId,
    summary.peerUserId,
    token,
  );
  await saveContextTokensDocument(runtime.storagePaths.contextTokensPath, runtime.contextTokensDoc);
}

async function markAccountStatus(runtime, accountId, status, lastError = '') {
  const normalizedAccountId = trimString(accountId);
  const current = runtime.accountsDoc.accounts?.[normalizedAccountId];
  if (!current) return;
  runtime.accountsDoc.accounts[normalizedAccountId] = normalizeAccountRecord({
    ...current,
    status,
    lastError: trimString(lastError),
    savedAt: current.savedAt || nowIso(),
  }, normalizedAccountId);
  await saveAccountsDocument(runtime.storagePaths.accountsPath, runtime.accountsDoc);
}

async function handleWeChatMessage(runtime, summary, helpers = {}) {
  const wasHandled = helpers.wasMessageHandled || wasMessageHandled;
  const markHandled = helpers.markMessageHandled || markMessageHandled;
  const generateReply = helpers.generateRemoteLabReply || generateRemoteLabReply;
  const sendText = helpers.sendWeChatText || sendWeChatText;

  const messageKey = buildHandledMessageKey(summary);
  if (!isProcessableMessage(summary)) {
    return;
  }
  if (runtime.processingMessageIds.has(messageKey)) {
    return;
  }
  if (await wasHandled(runtime.storagePaths.handledMessagesPath, messageKey)) {
    return;
  }

  runtime.processingMessageIds.add(messageKey);
  const processingStartedAt = Date.now();
  const processingAckDelayMs = parseNonNegativeInteger(
    runtime?.config?.processingAckDelayMs,
    DEFAULT_PROCESSING_ACK_DELAY_MS,
  );
  const processingAckText = trimString(summary.textPreview)
    ? buildProcessingAck(summary, runtime?.config?.processingAckText)
    : '';
  let processingAck = null;
  let processingAckPromise = null;
  let processingAckTimer = null;
  let processingAckAttempted = false;

  const maybeSendProcessingAck = async () => {
    if (processingAckAttempted || !processingAckText) {
      return processingAck;
    }
    processingAckAttempted = true;
    try {
      const reply = await sendText(runtime, summary, processingAckText);
      processingAck = {
        messageId: trimString(reply?.message_id),
        sentAt: nowIso(),
      };
      logConnectorStage('processing ack sent', {
        messageId: summary.messageId,
        responseMessageId: processingAck.messageId,
        ackDelayMs: elapsedMs(processingStartedAt),
      });
      return processingAck;
    } catch (ackError) {
      console.warn(`[wechat-connector] processing ack failed for ${summary.messageId}:`, ackError?.stack || ackError);
      return null;
    }
  };

  const getProcessingAckMetadata = () => processingAck
    ? {
      processingAckMessageId: processingAck.messageId || '',
      processingAckSentAt: processingAck.sentAt || '',
    }
    : {};
  try {
    logConnectorStage('processing started', {
      messageId: summary.messageId,
      peerUserId: summary.peerUserId,
      text: summary.textPreview || summary.contentSummary,
    });
    await persistContextToken(runtime, summary);

    if (!trimString(summary.textPreview)) {
      await markHandled(runtime.storagePaths.handledMessagesPath, messageKey, {
        status: 'silent_no_reply',
        accountId: summary.accountId,
        peerUserId: summary.peerUserId,
        requestId: buildRequestId(summary),
        reason: 'unsupported_message_type',
        contentSummary: summary.contentSummary || '',
        processingMs: elapsedMs(processingStartedAt),
      });
      console.log(`[wechat-connector] no reply sent for ${summary.messageId} (unsupported message type: ${summary.contentSummary || 'unknown'})`);
      return;
    }

    if (processingAckDelayMs > 0 && processingAckText) {
      processingAckTimer = setTimeout(() => {
        processingAckPromise = maybeSendProcessingAck();
      }, processingAckDelayMs);
    }

    const generated = await generateReply(runtime, summary);
    if (processingAckTimer) {
      clearTimeout(processingAckTimer);
      processingAckTimer = null;
    }
    if (processingAckPromise) {
      await processingAckPromise;
    }
    const replyText = normalizeReplyText(generated.replyText);
    const finalReply = decideConnectorUserVisibleReply({
      replyText,
      duplicate: generated.duplicate,
      silentConfirmationText: normalizeReplyText(runtime?.config?.silentConfirmationText),
    });
    if (finalReply.action === 'silent') {
      await markHandled(runtime.storagePaths.handledMessagesPath, messageKey, {
        status: finalReply.status,
        accountId: summary.accountId,
        peerUserId: summary.peerUserId,
        sessionId: generated.sessionId,
        runId: generated.runId,
        requestId: generated.requestId,
        duplicate: generated.duplicate,
        reason: finalReply.reason,
        ...getProcessingAckMetadata(),
        processingMs: elapsedMs(processingStartedAt),
        pipelineMs: generated.timingMs?.total,
        runMs: generated.timingMs?.run,
      });
      console.log(`[wechat-connector] no reply sent for ${summary.messageId} (${finalReply.reason})`);
      return;
    }

    const replySendStartedAt = Date.now();
    const reply = await sendText(runtime, summary, finalReply.text);
    const replySendMs = elapsedMs(replySendStartedAt);
    const processingMs = elapsedMs(processingStartedAt);
    await markHandled(runtime.storagePaths.handledMessagesPath, messageKey, {
      status: finalReply.status,
      accountId: summary.accountId,
      peerUserId: summary.peerUserId,
      sessionId: generated.sessionId,
      runId: generated.runId,
      requestId: generated.requestId,
      duplicate: generated.duplicate,
      ...(finalReply.reason ? { reason: finalReply.reason } : {}),
      ...(finalReply.action === 'send_confirmation' ? { confirmationText: finalReply.text } : {}),
      responseMessageId: reply.message_id || '',
      repliedAt: nowIso(),
      ...getProcessingAckMetadata(),
      processingMs,
      pipelineMs: generated.timingMs?.total,
      sessionMs: generated.timingMs?.session,
      submitMs: generated.timingMs?.submit,
      runMs: generated.timingMs?.run,
      replyLoadMs: generated.timingMs?.replyLoad,
      replySendMs,
      replyChars: finalReply.text.length,
    });
    logConnectorStage(finalReply.action === 'send_confirmation' ? 'confirmation sent' : 'processing finished', {
      messageId: summary.messageId,
      sessionId: generated.sessionId,
      runId: generated.runId,
      responseMessageId: reply.message_id || '',
      replyChars: finalReply.text.length,
      processingMs,
      pipelineMs: generated.timingMs?.total,
      runMs: generated.timingMs?.run,
      replySendMs,
    });
  } catch (error) {
    if (processingAckTimer) {
      clearTimeout(processingAckTimer);
      processingAckTimer = null;
    }
    if (processingAckPromise) {
      await processingAckPromise;
    }
    console.error(`[wechat-connector] processing failed for ${summary.messageId}:`, error?.stack || error);
    try {
      const fallback = buildFailureReply(summary, error?.message || '');
      const reply = await sendText(runtime, summary, fallback);
      await markHandled(runtime.storagePaths.handledMessagesPath, messageKey, {
        status: 'failed_with_notice',
        accountId: summary.accountId,
        peerUserId: summary.peerUserId,
        error: error?.message || String(error),
        responseMessageId: reply.message_id || '',
        repliedAt: nowIso(),
        ...getProcessingAckMetadata(),
        processingMs: elapsedMs(processingStartedAt),
      });
    } catch (sendError) {
      console.error(`[wechat-connector] fallback send failed for ${summary.messageId}:`, sendError?.stack || sendError);
    }
  } finally {
    if (processingAckTimer) {
      clearTimeout(processingAckTimer);
    }
    runtime.processingMessageIds.delete(messageKey);
  }
}

function buildPollAccountList(runtime, selectedAccountId = '', includeReauthRequired = false) {
  const requestedAccountId = trimString(selectedAccountId)
    || trimString(runtime?.config?.activeAccountId)
    || '';
  const allAccounts = Object.values(runtime?.accountsDoc?.accounts || {});
  if (requestedAccountId) {
    const selected = runtime?.accountsDoc?.accounts?.[requestedAccountId];
    return selected ? [selected] : [];
  }
  return allAccounts.filter((account) => {
    if (!trimString(account?.token)) return false;
    if (includeReauthRequired) return true;
    return trimString(account?.status).toLowerCase() !== 'reauth_required';
  });
}

async function pollAccountOnce(runtime, accountId, helpers = {}) {
  const getUpdatesImpl = helpers.getUpdates || getUpdates;
  const handleMessageImpl = helpers.handleWeChatMessage || handleWeChatMessage;
  const saveSyncStateImpl = helpers.saveSyncStateDocument || saveSyncStateDocument;

  const account = runtime.accountsDoc.accounts?.[trimString(accountId)];
  if (!account) {
    throw new Error(`Unknown WeChat account: ${accountId}`);
  }
  if (!trimString(account.token)) {
    throw new Error(`Missing WeChat token for account ${accountId}`);
  }

  const storedSync = runtime.syncStateDoc.accounts?.[accountId] || {};
  const timeoutMs = parsePositiveInteger(
    storedSync.longPollTimeoutMs,
    runtime.config.polling.timeoutMs,
  );
  const pollStartedAt = Date.now();
  const response = await getUpdatesImpl({
    baseUrl: account.baseUrl || runtime.config.apiBaseUrl,
    token: account.token,
    getUpdatesBuf: trimString(storedSync.getUpdatesBuf),
    timeoutMs,
  });

  if ((Number.isInteger(response?.ret) && response.ret !== 0) || (Number.isInteger(response?.errcode) && response.errcode !== 0)) {
    const errcode = Number.parseInt(String(response?.errcode || response?.ret || 0), 10) || 0;
    const errorText = trimString(response?.errmsg) || `WeChat getUpdates failed (${errcode || response?.ret || 'unknown'})`;
    if (errcode === -14) {
      await markAccountStatus(runtime, accountId, 'reauth_required', errorText);
      console.error(`[wechat-connector] account ${accountId} requires re-login: ${errorText}`);
      return { accountId, status: 'reauth_required', messages: 0 };
    }
    throw new Error(errorText);
  }

  const nextBuf = trimString(response?.get_updates_buf);
  const longPollTimeoutMs = parsePositiveInteger(response?.longpolling_timeout_ms, timeoutMs);
  if (nextBuf || storedSync.getUpdatesBuf || longPollTimeoutMs !== timeoutMs) {
    runtime.syncStateDoc = updateSyncCursor(runtime.syncStateDoc, accountId, {
      getUpdatesBuf: nextBuf || storedSync.getUpdatesBuf || '',
      longPollTimeoutMs,
      updatedAt: nowIso(),
    });
    await saveSyncStateImpl(runtime.storagePaths.syncStatePath, runtime.syncStateDoc);
  }

  const rawMessages = Array.isArray(response?.msgs) ? response.msgs : [];
  if (rawMessages.length > 0) {
    logConnectorStage('updates received', {
      accountId,
      messageCount: rawMessages.length,
      pollMs: elapsedMs(pollStartedAt),
      nextCursorBytes: nextBuf.length,
    });
  }
  let processedCount = 0;
  for (const rawMessage of rawMessages) {
    const summary = summarizeWeChatMessage(rawMessage, account);
    logConnectorStage('inbound message', {
      accountId,
      messageId: summary.messageId || '(missing)',
      seq: summary.seq,
      peerUserId: summary.peerUserId,
      text: summary.textPreview || summary.contentSummary,
    });
    await recordInboundEvent(runtime, summary, rawMessage, 'getupdates');
    await persistContextToken(runtime, summary);
    enqueueByChat(runtime, summary, () => handleMessageImpl(runtime, summary));
    processedCount += 1;
  }

  if (trimString(account.status).toLowerCase() !== 'ready' || trimString(account.lastError)) {
    await markAccountStatus(runtime, accountId, 'ready', '');
  }

  return {
    accountId,
    status: 'ok',
    messages: processedCount,
    longPollTimeoutMs,
  };
}

function parsePid(value) {
  const pid = Number.parseInt(String(value || '').trim(), 10);
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

async function claimConnectorPidLock(storageDir, processId = process.pid) {
  await ensureDir(storageDir);
  const pidPath = join(storageDir, CONNECTOR_PID_FILENAME);
  const pidValue = `${processId}\n`;
  try {
    await writeFile(pidPath, pidValue, { flag: 'wx' });
    return { pidPath, processId };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const existingPid = parsePid(await readFile(pidPath, 'utf8').catch(() => ''));
  if (existingPid && isProcessAlive(existingPid)) {
    throw new Error(`wechat connector already running with pid ${existingPid}`);
  }

  await writeFile(pidPath, pidValue);
  return { pidPath, processId };
}

async function releaseConnectorPidLock(lock) {
  if (!lock?.pidPath) return;
  try {
    const currentPid = parsePid(await readFile(lock.pidPath, 'utf8'));
    if (currentPid && currentPid !== lock.processId) return;
  } catch {}
  await rm(lock.pidPath, { force: true });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

async function showLinkedAccounts(config) {
  const accountsDoc = await loadAccountsDocument(config.storagePaths.accountsPath);
  const syncDoc = await loadSyncStateDocument(config.storagePaths.syncStatePath);
  const accountIds = Object.keys(accountsDoc.accounts);
  if (accountIds.length === 0) {
    console.log('[wechat-connector] no linked WeChat accounts');
    console.log(`[wechat-connector] login state file: ${config.storagePaths.loginStatePath}`);
    return;
  }

  console.log(`[wechat-connector] linked accounts: ${accountIds.length}`);
  for (const accountId of accountIds) {
    const record = accountsDoc.accounts[accountId];
    const sync = syncDoc.accounts?.[accountId] || {};
    const defaultLabel = accountId === accountsDoc.defaultAccountId ? ' (default)' : '';
    console.log(`${accountId}${defaultLabel}`);
    console.log(`  status: ${record.status || 'unknown'}`);
    console.log(`  token: ${maskToken(record.token)}`);
    console.log(`  baseUrl: ${record.baseUrl || DEFAULT_API_BASE_URL}`);
    console.log(`  userId: ${record.userId || '(unknown)'}`);
    console.log(`  savedAt: ${record.savedAt || '(unknown)'}`);
    console.log(`  lastLoginAt: ${record.lastLoginAt || '(unknown)'}`);
    console.log(`  lastError: ${record.lastError || '(none)'}`);
    console.log(`  syncCursor: ${trimString(sync.getUpdatesBuf) ? `${String(sync.getUpdatesBuf).length} bytes` : '(empty)'}`);
  }
}

async function runWeChatLogin(config, options = {}) {
  const existingLoginState = await readJson(config.storagePaths.loginStatePath, null);
  if (!options.force && existingLoginState?.status && existingLoginState.status !== 'confirmed') {
    console.log(`[wechat-connector] replacing previous login state (${existingLoginState.status})`);
  }

  const session = await startWeChatLogin(config);
  console.log('[wechat-connector] scan the QR code with WeChat to bind the connector');
  const rendered = await renderLoginQr(session.qrcodeUrl);
  if (!rendered) {
    console.log(session.qrcodeUrl);
  } else {
    console.log(`[wechat-connector] if the QR did not render cleanly, open this URL: ${session.qrcodeUrl}`);
  }

  const result = await waitForWeChatLogin(config, session);
  if (!result.connected) {
    throw new Error(result.message || 'WeChat login failed');
  }

  await persistLinkedAccount(config, result);
  await clearLoginState(config.storagePaths.loginStatePath);
  console.log(`[wechat-connector] linked account ${result.accountId}`);
  console.log(`[wechat-connector] base URL: ${result.baseUrl}`);
  if (result.userId) {
    console.log(`[wechat-connector] bound scanner user: ${result.userId}`);
  }
}

async function runPollLoop(runtime, options = {}) {
  await reloadRuntimeState(runtime, {
    accounts: true,
    syncState: true,
    contextTokens: true,
  });
  const initialAccounts = buildPollAccountList(runtime, options.accountId, options.force);

  console.log(
    `[wechat-connector] poller ready (${initialAccounts.length} account${initialAccounts.length === 1 ? '' : 's'}${initialAccounts.length === 0 ? '; awaiting login' : ''})`,
  );
  console.log(`[wechat-connector] RemoteLab base URL: ${runtime.config.chatBaseUrl}`);
  console.log(`[wechat-connector] storage dir: ${runtime.config.storageDir}`);
  console.log(
    `[wechat-connector] runtime selection: mode=${runtime.config.runtimeSelectionMode} fallbackTool=${runtime.config.sessionTool} fallbackModel=${runtime.config.model || '(default)'} fallbackEffort=${runtime.config.effort || '(default)'} fallbackThinking=${runtime.config.thinking ? 'on' : 'off'}`,
  );

  const startedAt = Date.now();
  const deadline = options.durationMs > 0 ? startedAt + options.durationMs : 0;
  let stopped = false;
  let waitingForAccounts = initialAccounts.length === 0;
  let replayedAccountsKey = '';

  const stop = (signal) => {
    if (stopped) return;
    stopped = true;
    console.log(`[wechat-connector] stopping (${signal})`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const maybeReplayStoredMessages = async (accounts = []) => {
    const accountIds = (Array.isArray(accounts) ? accounts : [])
      .map((account) => trimString(account?.accountId))
      .filter(Boolean)
      .sort();
    const nextKey = accountIds.join(',');
    if (!nextKey || nextKey === replayedAccountsKey) {
      return;
    }
    replayedAccountsKey = nextKey;
    await replayUnhandledMessages(runtime, { accountIds });
  };

  if (options.replayLast) {
    const replaySummary = await loadLatestReplayableSummary(runtime.storagePaths.eventsLogPath);
    if (!replaySummary) {
      throw new Error(`No replayable inbound message found in ${runtime.storagePaths.eventsLogPath}`);
    }
    const augmentedSummary = {
      ...replaySummary,
      contextToken: getStoredContextToken(runtime.contextTokensDoc, replaySummary.accountId, replaySummary.peerUserId),
    };
    console.log(`[wechat-connector] replaying stored message ${augmentedSummary.messageId}`);
    await handleWeChatMessage(runtime, augmentedSummary);
    if (!deadline) {
      return;
    }
  }

  await maybeReplayStoredMessages(initialAccounts);

  while (!stopped) {
    await reloadRuntimeState(runtime, {
      accounts: true,
      syncState: true,
      contextTokens: true,
    });
    const activeAccounts = buildPollAccountList(runtime, options.accountId, options.force);
    if (activeAccounts.length === 0) {
      if (!waitingForAccounts) {
        console.log('[wechat-connector] no pollable accounts remain; waiting for re-login');
        waitingForAccounts = true;
      }
      await delay(runtime.config.polling.errorDelayMs);
      if (deadline && Date.now() >= deadline) break;
      continue;
    }
    if (waitingForAccounts) {
      console.log(`[wechat-connector] linked accounts detected; resuming polling (${activeAccounts.length})`);
      waitingForAccounts = false;
    }
    await maybeReplayStoredMessages(activeAccounts);

    const results = await Promise.allSettled(
      activeAccounts.map((account) => pollAccountOnce(runtime, account.accountId)),
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const accountId = activeAccounts[index]?.accountId || 'unknown';
      if (result.status === 'rejected') {
        console.error(`[wechat-connector] poll failed for ${accountId}:`, result.reason?.stack || result.reason);
        await markAccountStatus(runtime, accountId, 'error', result.reason?.message || String(result.reason));
      }
    }

    if (deadline && Date.now() >= deadline) {
      break;
    }
    await delay(runtime.config.polling.idleDelayMs);
  }
}

export {
  DEFAULT_SESSION_SYSTEM_PROMPT,
  buildExternalTriggerId,
  buildRemoteLabMessage,
  claimConnectorPidLock,
  createRuntimeContext,
  ensureAuthCookie,
  generateRemoteLabReply,
  getStoredContextToken,
  handleWeChatMessage,
  loadAccountsDocument,
  loadConfig,
  loadContextTokensDocument,
  loadSyncStateDocument,
  logoutWeChatAccount,
  normalizeReplyText,
  persistLinkedAccount,
  pollAccountOnce,
  replayUnhandledMessages,
  runPollLoop,
  releaseConnectorPidLock,
  resolveRedirectBaseUrl,
  sendDirectWeChatText,
  sendDirectWeChatTextForSession,
  saveAccountsDocument,
  saveContextTokensDocument,
  saveSyncStateDocument,
  sendWeChatText,
  setStoredContextToken,
  startWeChatLogin,
  summarizeWeChatMessage,
  updateSyncCursor,
  waitForWeChatLogin,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.configPath);

  if (options.action === 'login') {
    await runWeChatLogin(config, options);
    return;
  }
  if (options.action === 'status' || options.action === 'list-accounts') {
    await showLinkedAccounts(config);
    return;
  }
  if (options.action === 'logout') {
    await logoutWeChatAccount(config, options.accountId);
    return;
  }
  if (options.action === 'send' || options.action === 'send-session') {
    const runtime = createRuntimeContext(config, {
      accountsDoc: await loadAccountsDocument(config.storagePaths.accountsPath),
      contextTokensDoc: await loadContextTokensDocument(config.storagePaths.contextTokensPath),
    });
    if (options.action === 'send-session') {
      await sendDirectWeChatTextForSession(runtime, options.sessionId, options.text);
    } else {
      await sendDirectWeChatText(runtime, {
        accountId: options.accountId,
        peerUserId: options.peerUserId,
        contextToken: options.contextToken,
        text: options.text,
      });
    }
    return;
  }

  const connectorPidLock = await claimConnectorPidLock(config.storageDir);
  let pidLockReleased = false;
  const releasePidLock = async () => {
    if (pidLockReleased) return;
    pidLockReleased = true;
    await releaseConnectorPidLock(connectorPidLock);
  };
  const releasePidLockOnBeforeExit = () => {
    void releasePidLock();
  };
  process.once('beforeExit', releasePidLockOnBeforeExit);

  try {
    const runtime = createRuntimeContext(config, {
      accountsDoc: await loadAccountsDocument(config.storagePaths.accountsPath),
      syncStateDoc: await loadSyncStateDocument(config.storagePaths.syncStatePath),
      contextTokensDoc: await loadContextTokensDocument(config.storagePaths.contextTokensPath),
    });
    const surfaceServer = await startWeChatSurfaceServer(runtime);
    if (surfaceServer?.baseUrl) {
      console.log(`[wechat-connector] surface ready at ${surfaceServer.baseUrl}${runtime.config.surface.entryPath}`);
    }
    try {
      await runPollLoop(runtime, options);
    } finally {
      await surfaceServer?.stop?.();
    }
  } finally {
    process.off('beforeExit', releasePidLockOnBeforeExit);
    await releasePidLock();
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error('[wechat-connector] fatal error:', error?.stack || error);
    process.exitCode = 1;
  });
}
