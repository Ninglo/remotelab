#!/usr/bin/env node

import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import * as Lark from '@larksuiteoapi/node-sdk';

import { createConnectorInbox } from '../lib/connector-inbox.mjs';
import { createDeliveryReceipts } from '../lib/delivery-receipts.mjs';
import { AUTH_FILE, CHAT_PORT, CONFIG_DIR } from '../lib/config.mjs';
import {
  normalizeExternalRuntimeSelectionMode,
  resolveExternalRuntimeSelection,
} from '../lib/external-runtime-selection.mjs';
import { loadMailboxRuntimeRegistry } from '../lib/mailbox-runtime-registry.mjs';
import {
  buildInstanceRuntimeCellEnvironment,
  ensureInstanceLarkCliBotProfile,
} from '../lib/instance-runtime-cell.mjs';
import { loadUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import {
  DEFAULT_FEISHU_SESSION_SYSTEM_PROMPT as DEFAULT_SESSION_SYSTEM_PROMPT,
  FEISHU_CONNECTOR_ID,
  FEISHU_CONNECTOR_NAME,
  LARK_CONNECTOR_NAME,
  LEGACY_DEFAULT_FEISHU_SESSION_SYSTEM_PROMPT as LEGACY_DEFAULT_SESSION_SYSTEM_PROMPT,
  buildExternalTriggerId,
  buildFeishuApiUuid,
  buildFeishuForkExternalTriggerId,
  buildFeishuForkSourceContext,
  buildFeishuPostContent,
  buildFeishuTopicId,
  buildMessageSourceContext,
  buildRemoteLabMessage,
  buildRequestId,
  buildSessionDescription,
  buildSessionSourceContext,
  compileFeishuReplyText,
  isFeishuDocumentCommentSummary,
  normalizeFeishuMode,
  normalizeReplyText,
  sanitizeIdPart,
  shouldReplyInFeishuThread,
  summarizeFeishuEvent as summarizeEvent,
  summarizeFeishuEventForLog as summarizeEventForLog,
} from '../connectors/feishu/index.mjs';
import {
  hydrateFeishuDocumentCommentSummary,
  sendFeishuCommentReply,
  summarizeFeishuDocumentCommentEvent,
} from '../connectors/feishu/comment-flow.mjs';
import { createFeishuInboundResourceService } from '../connectors/feishu/inbound-resources.mjs';
import {
  loadRemoteLabReplyAttachment as loadRemoteLabReplyAttachmentImpl,
  resolveFeishuOutboundFileType,
  sendFeishuAttachment as sendFeishuAttachmentImpl,
} from '../connectors/feishu/reply-attachments.mjs';
import { resolveFeishuFormulaImage } from '../connectors/feishu/math-renderer.mjs';
import { withTimeout } from '../lib/connector-driver-transports.mjs';
import { loadReplayableSummariesByMessageIds } from '../lib/feishu-replay.mjs';
import {
  normalizeFeishuGroupReplyPolicy,
  resolveFeishuBotIdentity,
  shouldRouteFeishuMessageToRemoteLab,
} from '../connectors/feishu/group-routing.mjs';
import {
  createConnectorSession,
  submitConnectorMessage,
} from '../lib/connector-turn-flow.mjs';
import {
  findFeishuThreadSessionBinding,
  recordFeishuMessageSession,
  recordFeishuOutboundMessageSession,
  recordFeishuThreadSessionBinding,
} from '../connectors/feishu/session-flow.mjs';

const CANONICAL_DEFAULT_CONFIG_PATH = join(CONFIG_DIR, 'feishu-connector', 'config.json');
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG_PATH = process.env.REMOTELAB_FEISHU_CONFIG_PATH
  ? resolve(process.env.REMOTELAB_FEISHU_CONFIG_PATH)
  : CANONICAL_DEFAULT_CONFIG_PATH;
const DEFAULT_ALLOWED_SENDERS_FILENAME = 'allowed-senders.json';
const DEFAULT_ACCESS_STATE_FILENAME = 'access-state.json';
const DEFAULT_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
const DEFAULT_SOURCE_DELIVERY_POLL_MS = 1000;
const DEFAULT_SESSION_TOOL = 'codex';
const DEFAULT_RUNTIME_SELECTION_MODE = 'ui';
const DEFAULT_FEISHU_API_TIMEOUT_MS = 10_000;
const DEFAULT_PROCESSING_REACTION_EMOJI_TYPE = 'THINKING';
const DEFAULT_PROCESSING_REACTION_TIMEOUT_MS = 10_000;
const CONNECTOR_PID_FILENAME = 'connector.pid';
const APPROVE_CURRENT_CHAT_COMMANDS = new Set([
  '授权本群',
  '授权这个群',
  'approve this group',
  'approve group',
  'trust this group',
  'trust this chat',
]);
const CHAT_ACCESS_STATUS_COMMANDS = new Set([
  '本群状态',
  '本群权限',
  '查看本群状态',
  '查看本群权限',
  'group access status',
  'chat access status',
]);

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    durationMs: 0,
    replayLast: false,
    replayMessageIds: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      options.configPath = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--duration-ms') {
      options.durationMs = parseDuration(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--replay-last') {
      options.replayLast = true;
      continue;
    }
    if (arg === '--replay-message-id') {
      const messageId = trimString(argv[index + 1]);
      if (!messageId) {
        throw new Error('Missing --replay-message-id value');
      }
      options.replayMessageIds.push(messageId);
      index += 1;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      printUsage(0);
    }
    printUsage(1);
  }

  if (!options.configPath) {
    throw new Error('Missing config path');
  }
  if (options.replayLast && options.replayMessageIds.length > 0) {
    throw new Error('--replay-last cannot be combined with --replay-message-id');
  }

  return options;
}

function parseDuration(value) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --duration-ms value: ${value || '(missing)'}`);
  }
  return parsed;
}

function printUsage(exitCode) {
  const message = `Usage:
  node scripts/feishu-connector.mjs [options]

Options:
  --config <path>        Config file path (default: ${DEFAULT_CONFIG_PATH})
  --duration-ms <ms>     Optional smoke-test duration before exit
  --replay-last          Reprocess the latest stored inbound message once
  --replay-message-id    Reprocess one stored inbound message by ID (repeatable)
  -h, --help             Show this help

Config shape:
  {
    "appId": "cli_xxx",
    "appSecret": "xxxx",
    "region": "feishu-cn",
    "loggerLevel": "info",
    "chatBaseUrl": "${DEFAULT_CHAT_BASE_URL}",
    "apiTimeoutMs": ${DEFAULT_FEISHU_API_TIMEOUT_MS},
    "sessionFolder": "${homedir()}",
    "runtimeSelectionMode": "${DEFAULT_RUNTIME_SELECTION_MODE}",
    "sessionTool": "${DEFAULT_SESSION_TOOL}",
    "model": "",
    "effort": "",
    "thinking": false,
    "systemPrompt": "${DEFAULT_SESSION_SYSTEM_PROMPT.replace(/"/g, '\\"')}",
    "processingReaction": {
      "enabled": false,
      "emojiType": "${DEFAULT_PROCESSING_REACTION_EMOJI_TYPE}",
      "removeOnCompletion": false,
      "timeoutMs": ${DEFAULT_PROCESSING_REACTION_TIMEOUT_MS}
    },
    "silentConfirmationText": "",
    "groupReplyPolicy": {
      "mode": "all",
      "chatModes": { "oc_example": "mention_only" }
    },
    "intakePolicy": {
      "mode": "allow_all",
      "accessStatePath": "~/.config/remotelab/feishu-connector/${DEFAULT_ACCESS_STATE_FILENAME}",
      "allowedSendersPath": "~/.config/remotelab/feishu-connector/${DEFAULT_ALLOWED_SENDERS_FILENAME}",
      "allowedSenders": {
        "openIds": [],
        "userIds": [],
        "unionIds": [],
        "tenantKeys": []
      }
    }
  }
`;
  const output = exitCode === 0 ? console.log : console.error;
  output(message);
  process.exit(exitCode);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRegion(value) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized || normalized === 'feishu' || normalized === 'feishu-cn' || normalized === 'cn') return 'feishu-cn';
  if (normalized === 'lark' || normalized === 'lark-global' || normalized === 'global' || normalized === 'sg') return 'lark-global';
  throw new Error(`Unsupported region: ${value || '(missing)'}`);
}

function resolveDomain(region) {
  return region === 'lark-global' ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

function resolveLoggerLevel(value) {
  const normalized = trimString(value || 'info').toLowerCase();
  if (normalized === 'debug') return Lark.LoggerLevel.debug;
  if (normalized === 'warn') return Lark.LoggerLevel.warn;
  if (normalized === 'error') return Lark.LoggerLevel.error;
  return Lark.LoggerLevel.info;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((value) => trimString(value)).filter(Boolean)));
}

function normalizeAllowedSenders(value) {
  const allowedSenders = value || {};
  return {
    openIds: normalizeStringArray(allowedSenders.openIds),
    userIds: normalizeStringArray(allowedSenders.userIds),
    unionIds: normalizeStringArray(allowedSenders.unionIds),
    tenantKeys: normalizeStringArray(allowedSenders.tenantKeys),
  };
}

function normalizeApprovedChatRecord(value, fallbackChatId = '') {
  const chatId = trimString(value?.chatId || fallbackChatId);
  if (!chatId) return null;
  return {
    chatId,
    name: trimString(value?.name),
    tenantKey: trimString(value?.tenantKey),
    autoApproveNewMembers: value?.autoApproveNewMembers !== false,
    source: trimString(value?.source || 'manual'),
    createdAt: trimString(value?.createdAt),
    updatedAt: trimString(value?.updatedAt),
  };
}

function normalizeApprovedChats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [key, chat] of Object.entries(value)) {
    const record = normalizeApprovedChatRecord(chat, key);
    if (!record) continue;
    normalized[record.chatId] = record;
  }
  return normalized;
}

function normalizeMembershipGrantRecord(value, fallbackKey = '') {
  const chatId = trimString(value?.chatId || fallbackKey.split(':', 1)[0]);
  const openId = trimString(value?.openId);
  const userId = trimString(value?.userId);
  const unionId = trimString(value?.unionId);
  const tenantKey = trimString(value?.tenantKey);
  if (!chatId) return null;
  if (!openId && !userId && !unionId && !tenantKey) return null;
  return {
    chatId,
    openId,
    userId,
    unionId,
    tenantKey,
    source: trimString(value?.source || 'manual'),
    grantedAt: trimString(value?.grantedAt),
    updatedAt: trimString(value?.updatedAt),
  };
}

function normalizeMembershipGrants(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [key, grant] of Object.entries(value)) {
    const record = normalizeMembershipGrantRecord(grant, key);
    if (!record) continue;
    const recordKey = key || `${record.chatId}:${record.openId || record.userId || record.unionId || record.tenantKey}`;
    normalized[recordKey] = record;
  }
  return normalized;
}

function normalizeAccessState(value) {
  return {
    version: 1,
    allowedSenders: normalizeAllowedSenders(value?.allowedSenders),
    approvedChats: normalizeApprovedChats(value?.approvedChats),
    membershipGrants: normalizeMembershipGrants(value?.membershipGrants),
  };
}

function createAllowedSendersCache(allowedSenders) {
  const normalized = normalizeAllowedSenders(allowedSenders);
  return {
    openIds: new Set(normalized.openIds),
    userIds: new Set(normalized.userIds),
    unionIds: new Set(normalized.unionIds),
    tenantKeys: new Set(normalized.tenantKeys),
  };
}

function snapshotAllowedSendersCache(cache) {
  return {
    openIds: Array.from(cache?.openIds || []).sort(),
    userIds: Array.from(cache?.userIds || []).sort(),
    unionIds: Array.from(cache?.unionIds || []).sort(),
    tenantKeys: Array.from(cache?.tenantKeys || []).sort(),
  };
}

function sortObjectKeys(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)));
}

function snapshotAccessState(access) {
  return {
    version: 1,
    allowedSenders: snapshotAllowedSendersCache(access?.allowedSendersCache),
    approvedChats: sortObjectKeys(access?.approvedChats),
    membershipGrants: sortObjectKeys(access?.membershipGrants),
  };
}

function resolveOptionalPath(value, baseDir, fallbackPath) {
  const normalized = trimString(value);
  if (!normalized) return fallbackPath;
  if (normalized.startsWith('~')) {
    return join(homedir(), normalized.slice(1));
  }
  if (normalized.startsWith('/')) {
    return normalized;
  }
  return resolve(baseDir, normalized);
}

function normalizeIntakePolicy(value, options = {}) {
  const mode = trimString(value?.mode || 'allow_all').toLowerCase();
  if (!['allow_all', 'whitelist'].includes(mode)) {
    throw new Error(`Unsupported intakePolicy.mode: ${value?.mode || '(missing)'}`);
  }

  const baseDir = options.baseDir || homedir();
  const defaultAllowedSendersPath = options.defaultAllowedSendersPath || join(baseDir, DEFAULT_ALLOWED_SENDERS_FILENAME);
  const defaultAccessStatePath = options.defaultAccessStatePath || join(baseDir, DEFAULT_ACCESS_STATE_FILENAME);
  return {
    mode,
    accessStatePath: resolveOptionalPath(value?.accessStatePath, baseDir, defaultAccessStatePath),
    allowedSendersPath: resolveOptionalPath(value?.allowedSendersPath, baseDir, defaultAllowedSendersPath),
    allowedSenders: normalizeAllowedSenders(value?.allowedSenders),
  };
}

function normalizeBaseUrl(baseUrl) {
  const normalized = trimString(baseUrl);
  if (!normalized) {
    throw new Error('chat base URL is required');
  }
  return normalized.replace(/\/+$/, '');
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeReactionEmojiType(value, fallback = DEFAULT_PROCESSING_REACTION_EMOJI_TYPE) {
  const normalized = trimString(value).replace(/[^A-Za-z0-9_]/g, '').toUpperCase();
  return normalized || fallback;
}

function normalizePositiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeProcessingReactionConfig(value) {
  if (value === true) {
    return {
      enabled: true,
      emojiType: DEFAULT_PROCESSING_REACTION_EMOJI_TYPE,
      removeOnCompletion: false,
      timeoutMs: DEFAULT_PROCESSING_REACTION_TIMEOUT_MS,
    };
  }
  if (value === false) {
    return {
      enabled: false,
      emojiType: DEFAULT_PROCESSING_REACTION_EMOJI_TYPE,
      removeOnCompletion: false,
      timeoutMs: DEFAULT_PROCESSING_REACTION_TIMEOUT_MS,
    };
  }
  if (typeof value === 'string') {
    return {
      enabled: true,
      emojiType: normalizeReactionEmojiType(value),
      removeOnCompletion: false,
      timeoutMs: DEFAULT_PROCESSING_REACTION_TIMEOUT_MS,
    };
  }
  return {
    enabled: normalizeBoolean(value?.enabled, false),
    emojiType: normalizeReactionEmojiType(value?.emojiType),
    removeOnCompletion: normalizeBoolean(value?.removeOnCompletion, false),
    timeoutMs: normalizePositiveTimeout(value?.timeoutMs, DEFAULT_PROCESSING_REACTION_TIMEOUT_MS),
  };
}

function normalizeSystemPrompt(value) {
  const normalized = trimString(value);
  if (!normalized || normalized === DEFAULT_SESSION_SYSTEM_PROMPT || normalized === LEGACY_DEFAULT_SESSION_SYSTEM_PROMPT) {
    return '';
  }
  return normalized;
}

async function loadConfig(pathname) {
  const raw = await readFile(pathname, 'utf8');
  const parsed = JSON.parse(raw);
  const appId = trimString(parsed?.appId);
  const appSecret = trimString(parsed?.appSecret);
  if (!appId) throw new Error(`Missing appId in ${pathname}`);
  if (!appSecret) throw new Error(`Missing appSecret in ${pathname}`);
  const configDir = dirname(pathname);
  const storageDir = trimString(parsed?.storageDir) || configDir;
  const explicitBotId = trimString(parsed?.botId) ? sanitizeIdPart(parsed.botId) : '';
  const sourceRouteId = explicitBotId
    || (resolve(pathname) === resolve(CANONICAL_DEFAULT_CONFIG_PATH)
      ? 'default'
      : (sanitizeIdPart(basename(configDir)) || 'default'));
  return {
    appId,
    appSecret,
    region: normalizeRegion(parsed?.region),
    loggerLevel: trimString(parsed?.loggerLevel || 'info'),
    apiTimeoutMs: normalizePositiveTimeout(parsed?.apiTimeoutMs, DEFAULT_FEISHU_API_TIMEOUT_MS),
    storageDir,
    groupReplyPolicy: normalizeFeishuGroupReplyPolicy(parsed?.groupReplyPolicy),
    intakePolicy: normalizeIntakePolicy(parsed?.intakePolicy, {
      baseDir: configDir,
      defaultAccessStatePath: join(configDir, DEFAULT_ACCESS_STATE_FILENAME),
      defaultAllowedSendersPath: join(configDir, DEFAULT_ALLOWED_SENDERS_FILENAME),
    }),
    storeRawEvents: parsed?.storeRawEvents === true,
    chatBaseUrl: normalizeBaseUrl(parsed?.chatBaseUrl || DEFAULT_CHAT_BASE_URL),
    sessionFolder: trimString(parsed?.sessionFolder) || homedir(),
    runtimeSelectionMode: normalizeExternalRuntimeSelectionMode(parsed?.runtimeSelectionMode, DEFAULT_RUNTIME_SELECTION_MODE),
    sessionTool: trimString(parsed?.sessionTool) || DEFAULT_SESSION_TOOL,
    model: trimString(parsed?.model),
    effort: trimString(parsed?.effort),
    thinking: normalizeBoolean(parsed?.thinking, false),
    systemPrompt: normalizeSystemPrompt(parsed?.systemPrompt),
    processingReaction: normalizeProcessingReactionConfig(parsed?.processingReaction),
    silentConfirmationText: normalizeReplyText(parsed?.silentConfirmationText),
    sourceRouteId,
  };
}

async function initializeFeishuInstanceRuntime(config, options = {}) {
  const instanceRoot = trimString(process.env.REMOTELAB_INSTANCE_ROOT)
    || trimString(config?.sessionFolder)
    || homedir();
  const runtimeCellEnvironment = buildInstanceRuntimeCellEnvironment({
    instanceRoot,
    projectRoot: PROJECT_ROOT,
  });
  const ensureProfile = typeof options.ensureProfile === 'function'
    ? options.ensureProfile
    : ensureInstanceLarkCliBotProfile;
  return ensureProfile({
    appId: config?.appId,
    appSecret: config?.appSecret,
    brand: config?.region === 'lark-global' ? 'lark' : 'feishu',
    configDir: trimString(process.env.LARKSUITE_CLI_CONFIG_DIR)
      || runtimeCellEnvironment.LARKSUITE_CLI_CONFIG_DIR,
    cliPath: join(PROJECT_ROOT, 'node_modules', '.bin', 'lark-cli'),
    baseEnv: {
      ...process.env,
      ...runtimeCellEnvironment,
    },
  });
}

function parsePid(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function claimConnectorPidLock(storageDir, processId = process.pid) {
  const pidPath = join(storageDir, CONNECTOR_PID_FILENAME);
  const pidValue = `${processId}\n`;
  await mkdir(storageDir, { recursive: true });
  try {
    await writeFile(pidPath, pidValue, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
    const existingPid = parsePid(await readFile(pidPath, 'utf8').catch(() => ''));
    if (existingPid && existingPid !== processId && isProcessAlive(existingPid)) {
      throw new Error(`Feishu connector already running (pid ${existingPid})`);
    }
    await rm(pidPath, { force: true });
    await writeFile(pidPath, pidValue, { flag: 'wx' });
  }
  return { pidPath, processId };
}

async function releaseConnectorPidLock(lock) {
  const pidPath = trimString(lock?.pidPath);
  if (!pidPath) {
    return;
  }
  const processId = parsePid(lock?.processId);
  if (!processId) {
    return;
  }
  const currentPid = parsePid(await readFile(pidPath, 'utf8').catch(() => ''));
  if (currentPid !== processId) {
    return;
  }
  await rm(pidPath, { force: true }).catch(() => {});
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
    const raw = await readFile(pathname, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(pathname, value) {
  await ensureDir(dirname(pathname));
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonAtomic(pathname, value) {
  await ensureDir(dirname(pathname));
  const tempPath = `${pathname}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, pathname);
}

async function readAllowedSendersFile(pathname) {
  try {
    const raw = await readFile(pathname, 'utf8');
    return {
      status: 'ok',
      allowedSenders: normalizeAllowedSenders(JSON.parse(raw)),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'missing', allowedSenders: null };
    }
    console.error(`[feishu-connector] failed to read whitelist file ${pathname}:`, error?.stack || error?.message || error);
    return { status: 'error', allowedSenders: null };
  }
}

async function readAccessStateFile(pathname) {
  try {
    const raw = await readFile(pathname, 'utf8');
    return {
      status: 'ok',
      accessState: normalizeAccessState(JSON.parse(raw)),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'missing', accessState: null };
    }
    console.error(`[feishu-connector] failed to read access state file ${pathname}:`, error?.stack || error?.message || error);
    return { status: 'error', accessState: null };
  }
}

function mergeAllowedSenders(...sources) {
  return normalizeAllowedSenders({
    openIds: sources.flatMap((source) => source?.openIds || []),
    userIds: sources.flatMap((source) => source?.userIds || []),
    unionIds: sources.flatMap((source) => source?.unionIds || []),
    tenantKeys: sources.flatMap((source) => source?.tenantKeys || []),
  });
}

async function ensureAllowedSendersFile(pathname, seedAllowedSenders) {
  const current = await readAllowedSendersFile(pathname);
  if (current.status !== 'missing') {
    return mergeAllowedSenders(seedAllowedSenders, current.allowedSenders);
  }

  const seeded = normalizeAllowedSenders(seedAllowedSenders);
  await writeJson(pathname, seeded);
  return seeded;
}

async function loadPersistedAccessState(policy) {
  const accessStateFile = await readAccessStateFile(policy.accessStatePath);
  const allowedSendersFile = await readAllowedSendersFile(policy.allowedSendersPath);
  const merged = normalizeAccessState({
    allowedSenders: mergeAllowedSenders(
      policy.allowedSenders,
      accessStateFile.accessState?.allowedSenders,
      allowedSendersFile.allowedSenders,
    ),
    approvedChats: accessStateFile.accessState?.approvedChats,
    membershipGrants: accessStateFile.accessState?.membershipGrants,
  });
  await writeJsonAtomic(policy.accessStatePath, merged);
  await writeJsonAtomic(policy.allowedSendersPath, merged.allowedSenders);
  return merged;
}

async function loadEffectiveAllowedSenders(policy) {
  const fileState = await readAllowedSendersFile(policy.allowedSendersPath);
  if (fileState.status === 'ok' && fileState.allowedSenders) {
    return fileState.allowedSenders;
  }
  return normalizeAllowedSenders(policy.allowedSenders);
}

function senderHasAllowedAccess(cache, summary) {
  const sender = summary?.sender || {};
  const tenantKey = trimString(sender?.tenantKey || summary?.tenantKey);
  return (
    cache?.openIds?.has(trimString(sender?.openId))
    || cache?.userIds?.has(trimString(sender?.userId))
    || cache?.unionIds?.has(trimString(sender?.unionId))
    || cache?.tenantKeys?.has(tenantKey)
  );
}

function normalizeGrantIdentity(sender, fallbackTenantKey = '') {
  return {
    openId: trimString(sender?.openId),
    userId: trimString(sender?.userId),
    unionId: trimString(sender?.unionId),
    tenantKey: trimString(sender?.tenantKey || fallbackTenantKey),
  };
}

function membershipGrantKey(chatId, sender) {
  const normalizedChatId = trimString(chatId);
  const normalizedSender = normalizeGrantIdentity(sender);
  const identityKey = normalizedSender.openId || normalizedSender.userId || normalizedSender.unionId || normalizedSender.tenantKey;
  if (!normalizedChatId || !identityKey) return '';
  return `${normalizedChatId}:${identityKey}`;
}

function grantSenderAccess(runtime, sender, options = {}) {
  if (!runtime?.access) return { changed: false, grantKey: '' };
  const identity = normalizeGrantIdentity(sender, options.tenantKey);
  if (!identity.openId && !identity.userId && !identity.unionId && !identity.tenantKey) {
    return { changed: false, grantKey: '' };
  }

  let changed = false;
  if (identity.openId && !runtime.access.allowedSendersCache.openIds.has(identity.openId)) {
    runtime.access.allowedSendersCache.openIds.add(identity.openId);
    changed = true;
  }
  if (identity.userId && !runtime.access.allowedSendersCache.userIds.has(identity.userId)) {
    runtime.access.allowedSendersCache.userIds.add(identity.userId);
    changed = true;
  }
  if (identity.unionId && !runtime.access.allowedSendersCache.unionIds.has(identity.unionId)) {
    runtime.access.allowedSendersCache.unionIds.add(identity.unionId);
    changed = true;
  }
  if (identity.tenantKey && !runtime.access.allowedSendersCache.tenantKeys.has(identity.tenantKey)) {
    runtime.access.allowedSendersCache.tenantKeys.add(identity.tenantKey);
    changed = true;
  }

  const grantKey = membershipGrantKey(options.chatId, identity);
  if (!grantKey) {
    return { changed, grantKey };
  }

  const existing = runtime.access.membershipGrants[grantKey] || {};
  const next = {
    chatId: trimString(options.chatId),
    openId: identity.openId,
    userId: identity.userId,
    unionId: identity.unionId,
    tenantKey: identity.tenantKey,
    source: trimString(options.source || existing.source || 'manual'),
    grantedAt: trimString(existing.grantedAt) || nowIso(),
    updatedAt: nowIso(),
  };
  if (JSON.stringify(existing) !== JSON.stringify(next)) {
    runtime.access.membershipGrants[grantKey] = next;
    changed = true;
  }
  return { changed, grantKey };
}

function upsertApprovedChat(runtime, chat) {
  if (!runtime?.access) return null;
  const normalized = normalizeApprovedChatRecord(chat, chat?.chatId || '');
  if (!normalized) return null;
  const existing = runtime.access.approvedChats[normalized.chatId] || {};
  const next = {
    chatId: normalized.chatId,
    name: normalized.name || trimString(existing.name),
    tenantKey: normalized.tenantKey || trimString(existing.tenantKey),
    autoApproveNewMembers: normalized.autoApproveNewMembers !== false,
    source: normalized.source || trimString(existing.source) || 'manual',
    createdAt: trimString(existing.createdAt) || normalized.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  runtime.access.approvedChats[next.chatId] = next;
  return next;
}

function isApprovedChat(runtime, chatId) {
  const normalizedChatId = trimString(chatId);
  const approved = runtime?.access?.approvedChats?.[normalizedChatId];
  return Boolean(approved) && approved.autoApproveNewMembers !== false;
}

function queueAccessStateFlush(runtime) {
  if (!runtime?.access || !runtime?.config?.intakePolicy) return Promise.resolve();
  runtime.access.flushPromise = (runtime.access.flushPromise || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const snapshot = snapshotAccessState(runtime.access);
      await writeJsonAtomic(runtime.config.intakePolicy.accessStatePath, snapshot);
      await writeJsonAtomic(runtime.config.intakePolicy.allowedSendersPath, snapshot.allowedSenders);
    });
  return runtime.access.flushPromise;
}

function senderIdentity(summary) {
  return {
    openId: summary?.sender?.openId || '',
    userId: summary?.sender?.userId || '',
    unionId: summary?.sender?.unionId || '',
    tenantKey: summary?.sender?.tenantKey || summary?.tenantKey || '',
    senderType: summary?.sender?.senderType || '',
    firstSeenMessageId: summary?.messageId || '',
    lastSeenMessageId: summary?.messageId || '',
    lastSeenChatId: summary?.chatId || '',
    lastSeenChatType: summary?.chatType || '',
    lastTextPreview: summary?.textPreview || summary?.contentSummary || '',
    mentionKeys: Array.isArray(summary?.mentions) ? summary.mentions.map((mention) => mention.key).filter(Boolean) : [],
  };
}

function mergeSenderIdentity(existing, incoming) {
  return {
    openId: existing?.openId || incoming.openId,
    userId: existing?.userId || incoming.userId,
    unionId: existing?.unionId || incoming.unionId,
    tenantKey: existing?.tenantKey || incoming.tenantKey,
    senderType: incoming.senderType || existing?.senderType || '',
    firstSeenMessageId: existing?.firstSeenMessageId || incoming.firstSeenMessageId,
    lastSeenMessageId: incoming.lastSeenMessageId || existing?.lastSeenMessageId || '',
    lastSeenChatId: incoming.lastSeenChatId || existing?.lastSeenChatId || '',
    lastSeenChatType: incoming.lastSeenChatType || existing?.lastSeenChatType || '',
    lastTextPreview: incoming.lastTextPreview || existing?.lastTextPreview || '',
    mentionKeys: Array.from(new Set([...(existing?.mentionKeys || []), ...(incoming.mentionKeys || [])])),
  };
}

function senderKey(identity) {
  return identity.openId || identity.userId || identity.unionId || identity.tenantKey || 'unknown_sender';
}

async function updateKnownSenders(pathname, summary) {
  const current = await readJson(pathname, { senders: {} });
  const incoming = senderIdentity(summary);
  const key = senderKey(incoming);
  current.senders[key] = mergeSenderIdentity(current.senders[key], incoming);
  await writeJson(pathname, current);
}

async function isAllowedByPolicy(policy, summary, access = null) {
  if (policy.mode !== 'whitelist') return true;
  if (access?.allowedSendersCache) {
    return senderHasAllowedAccess(access.allowedSendersCache, summary);
  }
  const sender = summary.sender || {};
  const allowed = await loadEffectiveAllowedSenders(policy);
  return (
    allowed.openIds.includes(sender.openId)
    || allowed.userIds.includes(sender.userId)
    || allowed.unionIds.includes(sender.unionId)
    || allowed.tenantKeys.includes(sender.tenantKey || summary.tenantKey)
  );
}

async function recordConnectorEvent(runtime, sourceLabel, summary, raw, allowed) {
  const record = {
    receivedAt: nowIso(),
    sourceLabel,
    allowed,
    summary,
    raw: runtime.config.storeRawEvents ? raw : undefined,
  };
  await appendJsonl(runtime.storagePaths.eventsLogPath, record);
  console.log(`[feishu-connector] inbound event ${sourceLabel} (${allowed ? 'allowed' : 'blocked'})`, JSON.stringify(summarizeEventForLog(summary)));
  return allowed;
}

async function recordInboundEvent(runtime, summary, raw, sourceLabel) {
  const allowed = await isAllowedByPolicy(runtime.config.intakePolicy, summary, runtime.access);
  await recordConnectorEvent(runtime, sourceLabel, summary, raw, allowed);
  await updateKnownSenders(runtime.storagePaths.knownSendersPath, summary);
  if (!allowed) {
    console.log('[feishu-connector] sender blocked by whitelist policy');
  }
  return allowed;
}

function buildSessionName() {
  return '';
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
    signal: AbortSignal.timeout(30000),
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
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  return { response, json, text };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
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
      if (parsed?.allowed === false) continue;
      if (!parsed?.summary?.messageId || !parsed?.summary?.chatId) continue;
      return parsed.summary;
    }
  } catch {}
  return null;
}

function createRuntimeContext(config, storagePaths, accessState) {
  return {
    config,
    storagePaths,
    access: {
      allowedSendersCache: createAllowedSendersCache(accessState?.allowedSenders),
      approvedChats: normalizeApprovedChats(accessState?.approvedChats),
      membershipGrants: normalizeMembershipGrants(accessState?.membershipGrants),
      flushPromise: Promise.resolve(),
    },
    appClient: new Lark.Client({
      httpInstance: { request: options => Lark.defaultHttpInstance.request({ ...options, timeout: 30000, signal: AbortSignal.timeout(30000) }) },
      appId: config.appId,
      appSecret: config.appSecret,
      domain: resolveDomain(config.region),
      loggerLevel: resolveLoggerLevel(config.loggerLevel),
    }),
    chatMetadataCache: new Map(),
    botIdentity: null,
    authToken: '',
    authCookie: '',
  };
}


async function loadFeishuChatMetadata(runtime, chatId) {
  const normalizedChatId = trimString(chatId);
  if (!normalizedChatId || !runtime?.appClient?.im?.v1?.chat?.get) {
    return null;
  }
  if (!runtime.chatMetadataCache) {
    runtime.chatMetadataCache = new Map();
  }
  if (runtime.chatMetadataCache.has(normalizedChatId)) {
    return runtime.chatMetadataCache.get(normalizedChatId);
  }

  try {
    const timeoutMs = normalizePositiveTimeout(runtime?.config?.apiTimeoutMs, DEFAULT_FEISHU_API_TIMEOUT_MS);
    const response = await withTimeout(
      () => runtime.appClient.im.v1.chat.get({
        params: {
          user_id_type: 'open_id',
        },
        path: {
          chat_id: normalizedChatId,
        },
      }),
      timeoutMs,
      'Feishu chat metadata lookup',
    );
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(response.msg || `Failed to load Feishu chat metadata (${response.code})`);
    }
    const metadata = {
      name: trimString(response.data?.name),
      groupMessageType: trimString(response.data?.group_message_type),
      chatMode: trimString(response.data?.chat_mode),
      chatType: trimString(response.data?.chat_type),
    };
    runtime.chatMetadataCache.set(normalizedChatId, metadata);
    return metadata;
  } catch (error) {
    console.warn(`[feishu-connector] failed to load chat metadata for ${normalizedChatId}: ${error?.message || error}`);
    runtime.chatMetadataCache.set(normalizedChatId, null);
    return null;
  }
}

async function enrichSummaryWithChatMetadata(runtime, summary) {
  if (!summary || typeof summary !== 'object') {
    return summary;
  }
  const chatType = normalizeFeishuMode(summary.chatType);
  if (!['group', 'topic'].includes(chatType)) {
    return summary;
  }

  const hasTopicMode = trimString(summary.groupMessageType) || trimString(summary.chatMode);
  if (hasTopicMode) {
    return summary;
  }

  const metadata = await loadFeishuChatMetadata(runtime, summary.chatId);
  if (!metadata) {
    return summary;
  }

  return {
    ...summary,
    chatName: trimString(summary.chatName) || metadata.name,
    groupMessageType: trimString(summary.groupMessageType) || metadata.groupMessageType,
    chatMode: trimString(summary.chatMode) || metadata.chatMode,
    chatType: trimString(summary.chatType) || metadata.chatType,
  };
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

const inboundResourceService = createFeishuInboundResourceService({
  requestRemoteLab,
  ensureAuthCookie,
});

async function downloadFeishuMessageResource(runtime, options = {}) {
  return await inboundResourceService.download(runtime, options);
}

async function resolveFeishuMessageAttachments(runtime, summary, options = {}) {
  return await inboundResourceService.resolve(runtime, summary, options);
}

async function loadRemoteLabReplyAttachment(runtime, attachment) {
  return loadRemoteLabReplyAttachmentImpl(runtime, attachment, { ensureAuthCookie });
}

async function resolveTargetConfigDir(chatBaseUrl) {
  try {
    const normalized = chatBaseUrl?.replace(/\/+$/, '').toLowerCase();
    if (!normalized) return '';
    const registry = await loadMailboxRuntimeRegistry();
    for (const record of registry) {
      const local = (record.localBaseUrl || '').replace(/\/+$/, '').toLowerCase();
      const pub = (record.publicBaseUrl || '').replace(/\/+$/, '').toLowerCase();
      if ((local && local === normalized) || (pub && pub === normalized)) {
        return trimString(record.configDir);
      }
    }
  } catch { /* guest registry not available */ }
  return '';
}

async function resolveFeishuRuntimeSelection(runtime) {
  const targetConfigDir = await resolveTargetConfigDir(runtime?.config?.chatBaseUrl);
  const selectionFile = targetConfigDir
    ? join(targetConfigDir, 'ui-runtime-selection.json')
    : undefined;
  const uiSelection = await loadUiRuntimeSelection(selectionFile);
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

async function submitRemoteLabRequest(runtime, summary, { prepared = null, saveSubmission = async () => {} } = {}) {
  const requester = (path, options = {}) => requestRemoteLab(runtime, path, options);
  if (prepared) {
    const submission = await submitConnectorMessage(requester, prepared.sessionId, prepared.payload);
    return { ...prepared.receipt, sessionId: prepared.sessionId, runId: submission.runId,
      requestId: submission.requestId, responseId: submission.responseId,
      duplicate: submission.duplicate, queued: submission.queued };
  }
  const effectiveSummary = {
    ...await enrichSummaryWithChatMetadata(runtime, summary),
    sourceRouteId: runtime.config.sourceRouteId,
  };
  const isForkCommand = effectiveSummary.forkCommand === true;
  const externalTriggerId = isForkCommand
    ? buildFeishuForkExternalTriggerId(effectiveSummary)
    : buildExternalTriggerId(effectiveSummary);
  const runtimeSelection = await resolveFeishuRuntimeSelection(runtime);
  const sessionPayload = {
    folder: runtime.config.sessionFolder,
    tool: runtimeSelection.tool,
    name: buildSessionName(effectiveSummary),
    sourceId: FEISHU_CONNECTOR_ID,
    sourceName: runtime.config.region === 'lark-global' ? LARK_CONNECTOR_NAME : FEISHU_CONNECTOR_NAME,
    group: FEISHU_CONNECTOR_NAME,
    description: buildSessionDescription(effectiveSummary),
    systemPrompt: runtime.config.systemPrompt,
    externalTriggerId,
    sourceContext: isForkCommand
      ? buildFeishuForkSourceContext(effectiveSummary)
      : buildSessionSourceContext(effectiveSummary),
  };
  const threadBinding = isForkCommand
    ? null
    : await findFeishuThreadSessionBinding(runtime, effectiveSummary);
  const session = threadBinding?.sessionId
    ? { id: threadBinding.sessionId }
    : await createConnectorSession(requester, sessionPayload);
  const attachmentResolution = await resolveFeishuMessageAttachments(runtime, effectiveSummary, {
    sessionId: session.id,
  });
  const messageSummary = attachmentResolution.failures.length > 0
    ? { ...effectiveSummary, attachmentDownloadFailures: attachmentResolution.failures }
    : effectiveSummary;
  const payload = {
    requestId: buildRequestId(effectiveSummary),
    sourceDelivery: { connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId || 'default', target: effectiveSummary },
    text: isForkCommand ? trimString(effectiveSummary.forkText) : buildRemoteLabMessage(messageSummary),
    tool: runtimeSelection.tool,
    sourceContext: isForkCommand
      ? buildFeishuForkSourceContext(messageSummary)
      : buildMessageSourceContext(messageSummary),
    ...(attachmentResolution.attachments.length > 0 ? { attachments: attachmentResolution.attachments } : {}),
    ...(runtimeSelection.thinking ? { thinking: true } : {}),
    ...(runtimeSelection.model ? { model: runtimeSelection.model } : {}),
    ...(runtimeSelection.effort ? { effort: runtimeSelection.effort } : {}),
  };
  const handoff = { sessionId: session.id, payload, receipt: {
    externalTriggerId, attachmentCount: attachmentResolution.attachments.length,
    attachmentDownloadFailureCount: attachmentResolution.failures.length,
  } };
  await saveSubmission(handoff);
  return submitRemoteLabRequest(runtime, summary, { prepared: handoff });
}

function isProcessingReactionEnabled(runtime) {
  return runtime?.config?.processingReaction?.enabled === true;
}

async function addProcessingReaction(runtime, summary) {
  if (isFeishuDocumentCommentSummary(summary)) {
    return null;
  }
  if (!isProcessingReactionEnabled(runtime)) {
    return null;
  }
  const messageId = trimString(summary?.messageId);
  if (!messageId) {
    return null;
  }
  const emojiType = normalizeReactionEmojiType(runtime?.config?.processingReaction?.emojiType);
  const timeoutMs = normalizePositiveTimeout(
    runtime?.config?.processingReaction?.timeoutMs,
    DEFAULT_PROCESSING_REACTION_TIMEOUT_MS,
  );
  const response = await withTimeout(
    () => runtime.appClient.im.v1.messageReaction.create({
      path: {
        message_id: messageId,
      },
      data: {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
    }),
    timeoutMs,
    'Feishu processing reaction',
  );
  if ((response.code !== undefined && response.code !== 0) || !response.data?.reaction_id) {
    throw new Error(response.msg || 'Failed to add Feishu processing reaction');
  }
  return {
    reactionId: response.data.reaction_id,
    emojiType: response.data?.reaction_type?.emoji_type || emojiType,
  };
}

async function removeProcessingReaction(runtime, summary, reaction) {
  if (isFeishuDocumentCommentSummary(summary)) {
    return false;
  }
  if (runtime?.config?.processingReaction?.removeOnCompletion === false) {
    return false;
  }
  const messageId = trimString(summary?.messageId);
  const reactionId = trimString(reaction?.reactionId);
  if (!messageId || !reactionId) {
    return false;
  }
  const timeoutMs = normalizePositiveTimeout(
    runtime?.config?.processingReaction?.timeoutMs,
    DEFAULT_PROCESSING_REACTION_TIMEOUT_MS,
  );
  const response = await withTimeout(
    () => runtime.appClient.im.v1.messageReaction.delete({
      path: {
        message_id: messageId,
        reaction_id: reactionId,
      },
    }),
    timeoutMs,
    'Feishu processing reaction removal',
  );
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(response.msg || 'Failed to remove Feishu processing reaction');
  }
  return true;
}

async function sendFeishuText(runtime, summary, text, uuid = '', mentions = summary?.mentions) {
  if (isFeishuDocumentCommentSummary(summary)) {
    return sendFeishuCommentReply(runtime, summary, text);
  }
  const content = await buildFeishuPostContent(text, mentions, {
    resolveFormulaImage: (formula) => resolveFeishuFormulaImage(runtime, formula),
    onFormulaError: (error, formula) => {
      console.warn(
        `[feishu-connector] ${formula?.display ? 'display' : 'inline'} formula fallback: ${error?.message || error}`,
      );
    },
  });
  const replyUuid = buildFeishuApiUuid(uuid, summary);
  if (shouldReplyInFeishuThread(summary)) {
    const response = await runtime.appClient.im.v1.message.reply({
      path: {
        message_id: summary.messageId,
      },
      data: {
        msg_type: 'post',
        content,
        reply_in_thread: true,
        uuid: replyUuid,
      },
    });
    if ((response.code !== undefined && response.code !== 0) || !response.data?.message_id) {
      throw new Error(response.msg || 'Failed to send Feishu topic reply');
    }
    return response.data;
  }

  const response = await runtime.appClient.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: summary.chatId,
      msg_type: 'post',
      content,
      uuid: replyUuid,
    },
  });
  if ((response.code !== undefined && response.code !== 0) || !response.data?.message_id) {
    throw new Error(response.msg || 'Failed to send Feishu reply');
  }
  return response.data;
}

async function sendFeishuAttachment(runtime, summary, attachment, uuid = '') {
  return sendFeishuAttachmentImpl(runtime, summary, attachment, uuid, { ensureAuthCookie });
}

async function processSourceDeliveryOnce(runtime, helpers = {}) {
  const request = helpers.requestRemoteLab || ((path, options) => requestRemoteLab(runtime, path, options));
  const receipts = runtime.deliveryReceipts ||= createDeliveryReceipts(join(runtime.config.storageDir, 'delivery-receipts'));
  const acknowledge = async receipt => {
    if (receipt.sessionId && receipt.messageId && runtime.storagePaths?.messageIndexPath) {
      await recordFeishuOutboundMessageSession(runtime, receipt.target, receipt.sessionId, receipt.messageId);
      await recordFeishuThreadSessionBinding(runtime, receipt.target, receipt.sessionId, { threadId: receipt.threadId });
    }
    const completed = await request(`/api/source-deliveries/${receipt.deliveryId}/complete`, { method: 'POST', body: {
      leaseId: receipt.leaseId, externalId: receipt.externalId,
    } });
    if (!completed.response.ok) throw new Error(completed.json?.error || 'Failed to record delivery receipt');
    return completed.json.delivery;
  };
  await receipts.flush(acknowledge);
  const { response, json } = await request('/api/source-deliveries/claim', { method: 'POST', body: {
    connector: FEISHU_CONNECTOR_ID, sourceRouteId: runtime.config.sourceRouteId || 'default',
  } });
  if (!response.ok) throw new Error(json?.error || 'Failed to claim delivery');
  const claim = json?.claim;
  if (!claim) return null;
  const delivery = claim.delivery;
  const summary = { ...delivery.target, mentions: [] };
  let sent;
  try {
    sent = delivery.attachment
      ? await (helpers.sendFeishuAttachment || sendFeishuAttachment)(runtime, summary, delivery.attachment, delivery.id)
      : await (helpers.sendFeishuText || sendFeishuText)(runtime, summary, delivery.text, delivery.id);
  } catch (error) {
    // A network timeout cannot tell whether Feishu executed the operation.
    await request(`/api/source-deliveries/${delivery.id}/fail`, { method: 'POST', body: {
      leaseId: claim.leaseId, error: error.message,
      safeToRetry: error.response?.status === 429,
      definiteFailure: error.definiteFailure === true,
    } });
    throw error;
  }
  await receipts.record({ deliveryId: delivery.id, leaseId: claim.leaseId,
    externalId: sent.message_id || sent.reply_id || '', messageId: sent.message_id || '',
    threadId: sent.thread_id || '', sessionId: delivery.sessionId, target: summary });
  let completed;
  await receipts.flush(async receipt => { completed = await acknowledge(receipt); });
  return completed;
}

function startSourceDeliveryPoller(runtime, options = {}) {
  if (runtime.sourceDeliveryTimer) return runtime.sourceDeliveryTimer;
  const pollMs = Math.max(250, Number.parseInt(options.pollMs, 10) || DEFAULT_SOURCE_DELIVERY_POLL_MS);
  const tick = () => {
    if (runtime.sourceDeliveryPollPromise) return;
    runtime.sourceDeliveryPollPromise = processSourceDeliveryOnce(runtime)
      .catch((error) => {
        console.error(`[feishu-connector] source delivery poll failed: ${error?.message || error}`);
      })
      .finally(() => {
        runtime.sourceDeliveryPollPromise = null;
      });
  };
  runtime.sourceDeliveryTimer = setInterval(tick, pollMs);
  tick();
  return runtime.sourceDeliveryTimer;
}

function stopSourceDeliveryPoller(runtime) {
  if (!runtime?.sourceDeliveryTimer) return false;
  clearInterval(runtime.sourceDeliveryTimer);
  runtime.sourceDeliveryTimer = null;
  return true;
}

function isProcessableMessage(summary) {
  if (!summary?.messageId) return false;
  if (isFeishuDocumentCommentSummary(summary)) {
    if (!summary?.fileToken || !summary?.fileType || !summary?.commentId) return false;
    if (summary?.mentionedBot !== true) return false;
  } else if (!summary?.chatId) {
    return false;
  }
  const senderType = trimString(summary?.sender?.senderType).toLowerCase();
  if (senderType && senderType !== 'user') return false;
  return true;
}

function stripMentionTokens(text) {
  return String(text || '').replace(/@_[A-Za-z0-9_]+/g, ' ');
}

function stripLeadingMentionTokens(text) {
  return String(text || '').replace(/^\s*(?:@_[A-Za-z0-9_]+\s*)+/, '');
}

function normalizeLocalCommandText(text) {
  return trimString(
    stripMentionTokens(text)
      .replace(/[。！？!?]+$/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase(),
  );
}

function extractLocalCommand(summary) {
  const chatType = trimString(summary?.chatType).toLowerCase();
  if (!['group', 'topic'].includes(chatType)) return null;
  const rawText = summary?.messageText || summary?.textPreview || summary?.rawContent;
  const commandText = stripLeadingMentionTokens(rawText);
  const forkMatch = commandText.match(/^\/fork(?:[ \t\r\n]+([\s\S]*))?$/i);
  if (forkMatch) {
    return {
      type: 'fork',
      text: trimString(forkMatch[1]),
    };
  }
  const normalized = normalizeLocalCommandText(rawText);
  if (!normalized) return null;
  if (APPROVE_CURRENT_CHAT_COMMANDS.has(normalized)) {
    return { type: 'approve_current_chat' };
  }
  if (CHAT_ACCESS_STATUS_COMMANDS.has(normalized)) {
    return { type: 'chat_access_status' };
  }
  return null;
}

function buildApprovedChatReply(runtime, summary) {
  const approved = runtime?.access?.approvedChats?.[summary.chatId] || {};
  const name = trimString(approved.name);
  const chatLabel = name ? `${name}（chat_id=${summary.chatId}）` : `chat_id=${summary.chatId}`;
  return `已授权本群 ${chatLabel}。我已经写入本地状态；后续新成员进群后会自动开通权限，无需重启服务。`;
}

function buildChatAccessStatusReply(runtime, summary) {
  const approved = runtime?.access?.approvedChats?.[summary.chatId];
  if (!approved) {
    return `本群尚未授权（chat_id=${summary.chatId}）。如需授权，请发送“@我 授权本群”。`;
  }
  const name = trimString(approved.name);
  const label = name ? `${name}（chat_id=${approved.chatId}）` : `chat_id=${approved.chatId}`;
  return `本群已授权 ${label}。新成员自动开通：开启。状态已保存在本地。`;
}

async function handleLocalCommand(runtime, summary, command, sendText) {
  if (!runtime?.access) return { handled: false };

  if (command.type === 'approve_current_chat') {
    upsertApprovedChat(runtime, {
      chatId: summary.chatId,
      tenantKey: summary.tenantKey,
      source: 'manual_group_command',
      autoApproveNewMembers: true,
    });
    grantSenderAccess(runtime, summary.sender, {
      chatId: summary.chatId,
      tenantKey: summary.tenantKey,
      source: 'manual_group_command',
    });
    await queueAccessStateFlush(runtime);
    const reply = await sendText(runtime, summary, buildApprovedChatReply(runtime, summary));
    return {
      handled: true,
      status: 'approved_chat',
      commandType: command.type,
      responseMessageId: reply.message_id || '',
    };
  }

  if (command.type === 'chat_access_status') {
    const reply = await sendText(runtime, summary, buildChatAccessStatusReply(runtime, summary));
    return {
      handled: true,
      status: 'chat_access_status',
      commandType: command.type,
      responseMessageId: reply.message_id || '',
    };
  }

  return { handled: false };
}

function summarizeChatMemberUserAddedEvent(data) {
  const users = Array.isArray(data?.users) ? data.users : [];
  return {
    eventId: data?.event_id || '',
    eventType: data?.event_type || 'im.chat.member.user.added_v1',
    tenantKey: data?.tenant_key || '',
    appId: data?.app_id || '',
    createTime: data?.create_time || '',
    chatId: data?.chat_id || '',
    chatName: trimString(data?.name) || trimString(data?.i18n_names?.zh_cn) || trimString(data?.i18n_names?.en_us) || '',
    operator: {
      openId: data?.operator_id?.open_id || '',
      userId: data?.operator_id?.user_id || '',
      unionId: data?.operator_id?.union_id || '',
      tenantKey: data?.operator_tenant_key || '',
    },
    users: users.map((user) => ({
      name: trimString(user?.name),
      tenantKey: trimString(user?.tenant_key || data?.tenant_key),
      openId: trimString(user?.user_id?.open_id),
      userId: trimString(user?.user_id?.user_id),
      unionId: trimString(user?.user_id?.union_id),
    })).filter((user) => user.openId || user.userId || user.unionId || user.tenantKey),
  };
}

function joinEventSenderSummary(eventSummary, user) {
  const identityKey = user.openId || user.userId || user.unionId || user.tenantKey || 'unknown_sender';
  return {
    tenantKey: eventSummary.tenantKey,
    chatId: eventSummary.chatId,
    chatType: 'group',
    messageId: `join:${eventSummary.eventId || identityKey}`,
    messageType: 'event',
    textPreview: '',
    mentions: [],
    sender: {
      openId: user.openId,
      userId: user.userId,
      unionId: user.unionId,
      senderType: 'user',
      tenantKey: user.tenantKey || eventSummary.tenantKey,
    },
  };
}

async function handleChatMemberUserAdded(runtime, summary, raw, sourceLabel) {
  const approved = isApprovedChat(runtime, summary.chatId);
  await recordConnectorEvent(runtime, sourceLabel, summary, raw, approved);
  if (!approved) {
    console.log(`[feishu-connector] user joined unapproved chat ${summary.chatId}; no access granted`);
    return { grantedCount: 0, approved: false };
  }

  let grantedCount = 0;
  let changed = false;
  for (const user of summary.users) {
    const result = grantSenderAccess(runtime, user, {
      chatId: summary.chatId,
      tenantKey: user.tenantKey || summary.tenantKey,
      source: 'chat_member_join',
    });
    if (result.changed) {
      changed = true;
      grantedCount += 1;
    }
    await updateKnownSenders(runtime.storagePaths.knownSendersPath, joinEventSenderSummary(summary, user));
  }

  const approvedChat = runtime?.access?.approvedChats?.[summary.chatId];
  if (approvedChat && summary.chatName && approvedChat.name !== summary.chatName) {
    approvedChat.name = summary.chatName;
    approvedChat.updatedAt = nowIso();
    changed = true;
  }

  if (changed) {
    await queueAccessStateFlush(runtime);
  }
  console.log(`[feishu-connector] auto-approved ${grantedCount} new member(s) for chat ${summary.chatId}`);
  return { grantedCount, approved: true, changed };
}

async function queueFeishuReply(runtime, summary, text) {
  const result = await requestRemoteLab(runtime, '/api/source-deliveries', { method: 'POST', body: {
    responseId: buildRequestId(summary), text,
    sourceDelivery: { connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId || 'default', target: summary },
  } });
  if (!result.response.ok) throw new Error(result.json?.error || 'Failed to enqueue reply');
  return { message_id: '', deliveryId: result.json.delivery.id };
}

async function handleMessage(runtime, summary, sourceLabel, helpers = {}) {
  if (!isProcessableMessage(summary)) return { ignored: true };
  if (!isFeishuDocumentCommentSummary(summary) && !shouldRouteFeishuMessageToRemoteLab(runtime, summary)) {
    console.log(`[feishu-connector] skipped ${summary.messageId} (group reply policy requires a mention of this Bot)`);
    return { ignored: true, reason: 'group_reply_policy' };
  }
  if (isFeishuDocumentCommentSummary(summary)) summary = await (helpers.hydrateSummary || hydrateFeishuDocumentCommentSummary)(runtime, summary);
  const command = extractLocalCommand(summary);
  const enqueue = helpers.queueFeishuReply || queueFeishuReply;
  if (command?.type === 'fork' && !command.text) return enqueue(runtime, summary, '用法：/fork <任务文本>');
  if (command?.type === 'fork') summary = { ...summary, forkCommand: true, forkText: command.text, replyInThread: true };
  else if (command) {
    const local = await handleLocalCommand(runtime, summary, command, enqueue);
    if (local.handled) return local;
  }
  const receipt = await (helpers.submitRemoteLabRequest || submitRemoteLabRequest)(runtime, summary);
  if (runtime.storagePaths?.messageIndexPath) {
    await recordFeishuMessageSession(runtime, summary, receipt.sessionId, { externalTriggerId: receipt.externalTriggerId });
    await recordFeishuThreadSessionBinding(runtime, summary, receipt.sessionId, { externalTriggerId: receipt.externalTriggerId });
  }
  return receipt;
}

function initializeInbox(runtime) {
  return createConnectorInbox(join(runtime.config.storageDir, 'inbox'), {
    conversationKey: entry => entry.summary.chatId || entry.summary.fileToken,
    process: async (entry, update) => {
      if (entry.sourceLabel === 'im.chat.member.user.added_v1') return handleChatMemberUserAdded(runtime, entry.summary, entry.raw, entry.sourceLabel);
      const allowed = await recordInboundEvent(runtime, entry.summary, entry.raw, entry.sourceLabel);
      return allowed ? handleMessage(runtime, entry.summary, entry.sourceLabel, {
        submitRemoteLabRequest: (runtime, summary) => submitRemoteLabRequest(runtime, summary, {
          prepared: entry.submission, saveSubmission: submission => update({ submission }),
        }),
      }) : { blocked: true };
    },
    onError: error => console.error(`[feishu-inbox] ${error.message}`),
  });
}

export {
  DEFAULT_SESSION_SYSTEM_PROMPT,
  buildApprovedChatReply,
  buildChatAccessStatusReply,
  buildExternalTriggerId,
  buildFeishuForkExternalTriggerId,
  buildFeishuForkSourceContext,
  buildFeishuTopicId,
  buildMessageSourceContext,
  buildRemoteLabMessage,
  buildSessionDescription,
  buildSessionSourceContext,
  claimConnectorPidLock,
  buildFeishuPostContent,
  compileFeishuReplyText,
  createRuntimeContext,
  downloadFeishuMessageResource,
  ensureAuthCookie,
  ensureAllowedSendersFile,
  extractLocalCommand,
  findFeishuThreadSessionBinding,
  addProcessingReaction,
  submitRemoteLabRequest,
  grantSenderAccess,
  handleChatMemberUserAdded,
  handleMessage,
  isAllowedByPolicy,
  initializeFeishuInstanceRuntime,
  loadPersistedAccessState,
  loadConfig,
  normalizeAllowedSenders,
  normalizeProcessingReactionConfig,
  normalizeReplyText,
  queueAccessStateFlush,
  releaseConnectorPidLock,
  removeProcessingReaction,
  recordFeishuThreadSessionBinding,
  resolveFeishuMessageAttachments,
  resolveFeishuOutboundFileType,
  loadRemoteLabReplyAttachment,
  sendFeishuAttachment,
  sendFeishuText,
  processSourceDeliveryOnce,
  startSourceDeliveryPoller,
  stopSourceDeliveryPoller,
  snapshotAccessState,
  summarizeChatMemberUserAddedEvent,
  summarizeFeishuDocumentCommentEvent,
  hydrateFeishuDocumentCommentSummary,
  sendFeishuCommentReply,
  summarizeEvent,
  upsertApprovedChat,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
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
    const larkCliRuntime = await initializeFeishuInstanceRuntime(config);
    console.log(`[feishu-connector] instance lark-cli Bot profile ready (${larkCliRuntime.configDir})`);
  } catch (error) {
    process.off('beforeExit', releasePidLockOnBeforeExit);
    await releasePidLock();
    throw error;
  }
  const accessState = await loadPersistedAccessState(config.intakePolicy);
  const storagePaths = {
    eventsLogPath: join(config.storageDir, 'events.jsonl'),
    knownSendersPath: join(config.storageDir, 'known-senders.json'),
    messageIndexPath: join(config.storageDir, 'connector-message-index.json'),
  };
  const runtime = createRuntimeContext(config, storagePaths, accessState);
  if ([config.groupReplyPolicy.mode, ...Object.values(config.groupReplyPolicy.chatModes)].includes('mention_only')) {
    runtime.botIdentity = await withTimeout(
      () => resolveFeishuBotIdentity(runtime), config.apiTimeoutMs, 'Feishu Bot identity lookup',
    );
  }
  const inbox = initializeInbox(runtime);
  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: resolveDomain(config.region),
    loggerLevel: resolveLoggerLevel(config.loggerLevel),
  });

  let closed = false;
  const closeConnection = (reason) => {
    if (closed) return;
    closed = true;
    stopSourceDeliveryPoller(runtime);
    inbox.stop();
    console.log(`[feishu-connector] closing connection (${reason})`);
    wsClient.close();
  };
  const shutdownAndExit = async (reason, code = 0) => {
    closeConnection(reason);
    await inbox.idle();
    await runtime.sourceDeliveryPollPromise;
    await runtime.access.flushPromise;
    await releasePidLock();
    process.exit(code);
  };

  process.on('SIGINT', () => {
    void shutdownAndExit('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdownAndExit('SIGTERM');
  });

  const persist = (sourceLabel, summarize) => async raw => {
    const summary = summarize(raw);
    await inbox.accept(summary.messageId || summary.eventId, { summary, raw, sourceLabel });
    return {};
  };
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': persist('im.message.receive_v1', summarizeEvent),
    'im.chat.member.user.added_v1': persist('im.chat.member.user.added_v1', summarizeChatMemberUserAddedEvent),
    'drive.notice.comment_add_v1': persist('drive.notice.comment_add_v1', summarizeFeishuDocumentCommentEvent),
  });
  inbox.start();
  await wsClient.start({ eventDispatcher });
  startSourceDeliveryPoller(runtime);
  console.log(`[feishu-connector] persistent connection ready (${config.region})`);
  console.log(`[feishu-connector] intake policy: ${config.intakePolicy.mode}`);
  console.log(`[feishu-connector] group reply policy: ${JSON.stringify(config.groupReplyPolicy)}`);
  console.log(`[feishu-connector] access state file: ${config.intakePolicy.accessStatePath}`);
  console.log(`[feishu-connector] whitelist mirror: ${config.intakePolicy.allowedSendersPath}`);
  console.log(`[feishu-connector] event log: ${storagePaths.eventsLogPath}`);
  console.log(`[feishu-connector] known senders: ${storagePaths.knownSendersPath}`);
  console.log(`[feishu-connector] message index: ${storagePaths.messageIndexPath}`);
  console.log(`[feishu-connector] RemoteLab base URL: ${config.chatBaseUrl}`);
  console.log(`[feishu-connector] session folder: ${config.sessionFolder}`);
  console.log(
    `[feishu-connector] runtime selection: mode=${config.runtimeSelectionMode} fallbackTool=${config.sessionTool} fallbackModel=${config.model || '(default)'} fallbackEffort=${config.effort || '(default)'} fallbackThinking=${config.thinking ? 'on' : 'off'}`,
  );

  if (options.replayLast || options.replayMessageIds.length > 0) {
    let summaries = [];
    if (options.replayLast) {
      const summary = await loadLatestReplayableSummary(storagePaths.eventsLogPath);
      if (!summary) {
        throw new Error(`No replayable inbound message found in ${storagePaths.eventsLogPath}`);
      }
      summaries = [summary];
    } else {
      const replay = await loadReplayableSummariesByMessageIds(
        storagePaths.eventsLogPath,
        options.replayMessageIds,
      );
      if (replay.missingMessageIds.length > 0) {
        throw new Error(`Stored inbound messages not found: ${replay.missingMessageIds.join(', ')}`);
      }
      summaries = replay.summaries;
    }
    for (const summary of summaries) {
      console.log(`[feishu-connector] replaying stored message ${summary.messageId}`);
      await inbox.accept(summary.messageId, { summary, raw: null, sourceLabel: 'replay' });
      await inbox.tick();
      await inbox.idle();
    }
    if (options.durationMs === 0) {
      closeConnection('replay complete');
      await delay(250);
      await releasePidLock();
      process.off('beforeExit', releasePidLockOnBeforeExit);
      return;
    }
  }

  if (options.durationMs > 0) {
    await delay(options.durationMs);
    closeConnection(`duration ${options.durationMs}ms elapsed`);
    await delay(250);
    await releasePidLock();
    process.off('beforeExit', releasePidLockOnBeforeExit);
    return;
  }

  await new Promise(() => {});
}

if (isMainModule()) {
  main().catch((error) => {
    console.error('[feishu-connector] failed to start:', error?.stack || error?.message || error);
    process.exit(1);
  });
}
