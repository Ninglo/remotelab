#!/usr/bin/env node

import { readFileSync, rmSync } from 'fs';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { pathToFileURL } from 'url';
import * as Lark from '@larksuiteoapi/node-sdk';

import { AUTH_FILE, CHAT_PORT } from '../lib/config.mjs';
import {
  normalizeExternalRuntimeSelectionMode,
  resolveExternalRuntimeSelection,
} from '../lib/external-runtime-selection.mjs';
import { loadMailboxRuntimeRegistry } from '../lib/mailbox-runtime-registry.mjs';
import { selectAssistantReplyEvent, stripHiddenBlocks } from '../lib/reply-selection.mjs';
import { loadUiRuntimeSelection } from '../lib/runtime-selection.mjs';

const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'remotelab', 'feishu-connector', 'config.json');
const DEFAULT_ALLOWED_SENDERS_FILENAME = 'allowed-senders.json';
const DEFAULT_ACCESS_STATE_FILENAME = 'access-state.json';
const DEFAULT_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
const DEFAULT_SESSION_TOOL = 'codex';
const DEFAULT_RUNTIME_SELECTION_MODE = 'ui';
const LEGACY_DEFAULT_SESSION_SYSTEM_PROMPT = [
  'You are replying as a Feishu bot powered by RemoteLab on the user\'s own machine.',
  'For each assistant turn, output exactly the plain-text message to send back to Feishu.',
  'Keep replies concise, helpful, and natural.',
  'Match the user\'s language when practical.',
  'In group chats, prefer silence by default: if the message is mainly human-to-human chatter, laughter, status updates, side remarks, or is not clearly asking for you, output an empty string.',
  'Reply when you are directly addressed, clearly asked for help or information, asked to take an action, or when a short reply is genuinely useful.',
  'If the chat asks you to speak less or not reply to every message, treat that as an active local rule until someone clearly changes it.',
  'If you are unsure whether to reply, choose silence and output an empty string. An empty string means no Feishu message should be sent.',
  'Do not mention hidden connector, session, or run internals unless the user explicitly asks.',
].join('\n');
const DEFAULT_SESSION_SYSTEM_PROMPT = [
  'You are interacting through a Feishu or Lark bot on the user\'s own machine.',
  'Keep connector-specific overrides minimal and only describe constraints not already owned by RemoteLab backend prompt logic.',
].join('\n');
const RUN_POLL_INTERVAL_MS = 1500;
const RUN_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_FEISHU_TEXT_LENGTH = 5000;
const MAX_INBOUND_LOG_PREVIEW_LENGTH = 240;
const DEFAULT_PROCESSING_REACTION_EMOJI_TYPE = 'THINKING';
const CONNECTOR_PID_FILENAME = 'connector.pid';
const FEISHU_EMOJI_ALIAS_PATTERN = /\[(?:[\u3400-\u9FFF]{1,4})\]/gu;
const UNICODE_EMOJI_PATTERN = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0E|\uFE0F)?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0E|\uFE0F)?)*)/gu;
const REMOTELAB_SESSION_APP_ID = 'feishu';
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
    if (arg === '-h' || arg === '--help') {
      printUsage(0);
    }
    printUsage(1);
  }

  if (!options.configPath) {
    throw new Error('Missing config path');
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
  -h, --help             Show this help

Config shape:
  {
    "appId": "cli_xxx",
    "appSecret": "xxxx",
    "region": "feishu-cn",
    "loggerLevel": "info",
    "chatBaseUrl": "${DEFAULT_CHAT_BASE_URL}",
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
      "removeOnCompletion": false
    },
    "silentConfirmationText": "",
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

function normalizeProcessingReactionConfig(value) {
  if (value === true) {
    return {
      enabled: true,
      emojiType: DEFAULT_PROCESSING_REACTION_EMOJI_TYPE,
      removeOnCompletion: false,
    };
  }
  if (value === false) {
    return {
      enabled: false,
      emojiType: DEFAULT_PROCESSING_REACTION_EMOJI_TYPE,
      removeOnCompletion: false,
    };
  }
  if (typeof value === 'string') {
    return {
      enabled: true,
      emojiType: normalizeReactionEmojiType(value),
      removeOnCompletion: false,
    };
  }
  return {
    enabled: normalizeBoolean(value?.enabled, false),
    emojiType: normalizeReactionEmojiType(value?.emojiType),
    removeOnCompletion: normalizeBoolean(value?.removeOnCompletion, false),
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
  return {
    appId,
    appSecret,
    region: normalizeRegion(parsed?.region),
    loggerLevel: trimString(parsed?.loggerLevel || 'info'),
    storageDir,
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
  };
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

function releaseConnectorPidLock(lock) {
  const pidPath = trimString(lock?.pidPath);
  if (!pidPath) {
    return;
  }
  const processId = parsePid(lock?.processId);
  if (!processId) {
    return;
  }
  const currentPid = parsePid((() => {
    try {
      return readFileSync(pidPath, 'utf8');
    } catch {
      return '';
    }
  })());
  if (currentPid !== processId) {
    return;
  }
  try {
    rmSync(pidPath, { force: true });
  } catch {}
}

function parseTextPreview(rawContent) {
  const content = trimString(rawContent);
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.text === 'string') {
      return parsed.text;
    }
  } catch {}
  return '';
}

function parseMessageContent(rawContent) {
  const content = trimString(rawContent);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {}
  return null;
}

function truncateLogPreview(value, maxLength = MAX_INBOUND_LOG_PREVIEW_LENGTH) {
  const normalized = trimString(value).replace(/\s+/g, ' ');
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function collectStructuredText(value, fragments, seen, depth = 0) {
  if (depth > 5 || fragments.length >= 8 || value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    const normalized = trimString(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      fragments.push(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredText(item, fragments, seen, depth + 1);
      if (fragments.length >= 8) return;
    }
    return;
  }
  if (typeof value !== 'object') return;
  for (const key of ['title', 'text', 'name', 'label', 'content']) {
    if (!(key in value)) continue;
    collectStructuredText(value[key], fragments, seen, depth + 1);
    if (fragments.length >= 8) return;
  }
}

function extractStructuredTextPreview(value) {
  const fragments = [];
  collectStructuredText(value, fragments, new Set());
  return truncateLogPreview(fragments.join(' '));
}

function contentKeyPreview(parsedContent) {
  if (!parsedContent || Array.isArray(parsedContent) || typeof parsedContent !== 'object') {
    return [];
  }
  return Object.keys(parsedContent).filter(Boolean).slice(0, 6);
}

function summarizeMessageContent(messageType, rawContent) {
  const normalizedType = trimString(messageType).toLowerCase();
  const parsedContent = parseMessageContent(rawContent);
  let textPreview = '';

  if (normalizedType === 'text') {
    textPreview = parseTextPreview(rawContent) || trimString(rawContent);
  } else if (normalizedType === 'post') {
    textPreview = extractStructuredTextPreview(parsedContent);
  } else if (normalizedType === 'file') {
    textPreview = trimString(parsedContent?.file_name || parsedContent?.name);
  } else if (normalizedType === 'share_chat') {
    textPreview = trimString(parsedContent?.chat_name || parsedContent?.name || parsedContent?.chat_id);
  } else if (normalizedType === 'share_user') {
    textPreview = trimString(parsedContent?.user_name || parsedContent?.name || parsedContent?.user_id);
  } else if (normalizedType === 'location') {
    textPreview = trimString(parsedContent?.name || parsedContent?.title || parsedContent?.address);
  } else if (normalizedType === 'interactive') {
    textPreview = extractStructuredTextPreview(parsedContent);
  }

  const contentSummary = (() => {
    switch (normalizedType) {
      case 'text':
        return textPreview ? `Text message: ${truncateLogPreview(textPreview)}` : 'Text message';
      case 'image':
        return 'Image attachment';
      case 'file':
        return textPreview ? `File attachment: ${truncateLogPreview(textPreview)}` : 'File attachment';
      case 'audio':
        return 'Audio attachment';
      case 'media':
        return 'Media attachment';
      case 'sticker':
        return 'Sticker message';
      case 'post':
        return textPreview ? `Rich text post: ${truncateLogPreview(textPreview)}` : 'Rich text post';
      case 'share_chat':
        return textPreview ? `Shared chat: ${truncateLogPreview(textPreview)}` : 'Shared chat';
      case 'share_user':
        return textPreview ? `Shared contact: ${truncateLogPreview(textPreview)}` : 'Shared contact';
      case 'location':
        return textPreview ? `Location message: ${truncateLogPreview(textPreview)}` : 'Location message';
      case 'interactive':
        return textPreview ? `Interactive card: ${truncateLogPreview(textPreview)}` : 'Interactive card';
      default: {
        const typeLabel = normalizedType || 'unknown';
        const keys = contentKeyPreview(parsedContent);
        return keys.length
          ? `Unsupported message (${typeLabel}; keys=${keys.join(',')})`
          : `Unsupported message (${typeLabel})`;
      }
    }
  })();

  return {
    textPreview,
    contentSummary,
    contentKeys: contentKeyPreview(parsedContent),
  };
}

function summarizeEventForLog(summary) {
  return {
    eventId: summary?.eventId || '',
    eventType: summary?.eventType || '',
    chatId: summary?.chatId || '',
    chatType: summary?.chatType || '',
    messageId: summary?.messageId || '',
    messageType: summary?.messageType || '',
    threadId: summary?.threadId || '',
    senderOpenId: summary?.sender?.openId || '',
    mentionCount: Array.isArray(summary?.mentions) ? summary.mentions.length : 0,
    textPreview: truncateLogPreview(summary?.textPreview),
    contentSummary: truncateLogPreview(summary?.contentSummary),
  };
}

function summarizeEvent(data) {
  const sender = data?.sender || {};
  const senderId = sender?.sender_id || {};
  const message = data?.message || {};
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const rawContent = typeof message.content === 'string' ? message.content : '';
  const normalizedContent = summarizeMessageContent(message.message_type || '', rawContent);
  return {
    eventId: data?.event_id || '',
    eventType: data?.event_type || '',
    tenantKey: data?.tenant_key || '',
    appId: data?.app_id || '',
    createTime: data?.create_time || '',
    sender: {
      openId: senderId?.open_id || '',
      userId: senderId?.user_id || '',
      unionId: senderId?.union_id || '',
      senderType: sender?.sender_type || '',
      tenantKey: sender?.tenant_key || '',
    },
    chatId: message.chat_id || '',
    chatType: message.chat_type || '',
    messageId: message.message_id || '',
    rootId: message.root_id || '',
    parentId: message.parent_id || '',
    threadId: message.thread_id || '',
    messageType: message.message_type || '',
    mentions: mentions.map((mention) => ({
      key: mention?.key || '',
      name: mention?.name || '',
      openId: mention?.id?.open_id || '',
      userId: mention?.id?.user_id || '',
      unionId: mention?.id?.union_id || '',
      tenantKey: mention?.tenant_key || '',
    })),
    textPreview: normalizedContent.textPreview,
    contentSummary: normalizedContent.contentSummary,
    contentKeys: normalizedContent.contentKeys,
    rawContent,
  };
}

function summarizeLegacyMessageEvent(data) {
  const messageType = data?.msg_type || data?.message_type || '';
  const rawContent = typeof data?.text === 'string' ? data.text : '';
  const normalizedContent = summarizeMessageContent(messageType, rawContent);
  return {
    eventId: data?.uuid || data?.event_id || '',
    eventType: 'message',
    tenantKey: data?.tenant_key || '',
    appId: data?.app_id || '',
    createTime: data?.ts || '',
    sender: {
      openId: data?.open_id || data?.sender?.open_id || '',
      userId: data?.employee_id || data?.sender?.employee_id || '',
      unionId: '',
      senderType: 'user',
      tenantKey: data?.tenant_key || '',
    },
    chatId: data?.open_chat_id || data?.chat_id || '',
    chatType: data?.chat_type || '',
    messageId: data?.open_message_id || data?.message_id || '',
    rootId: '',
    parentId: '',
    threadId: '',
    messageType,
    mentions: [],
    textPreview: typeof data?.text_without_at_bot === 'string' ? data.text_without_at_bot : normalizedContent.textPreview,
    contentSummary: normalizedContent.contentSummary,
    contentKeys: normalizedContent.contentKeys,
    rawContent,
  };
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

function containsCjk(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text || '');
}

function sanitizeIdPart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function buildExternalTriggerId(summary) {
  return `feishu:${sanitizeIdPart(summary.chatType || 'chat')}:${sanitizeIdPart(summary.chatId || 'unknown_chat')}`;
}

function buildRequestId(summary) {
  return `feishu:${sanitizeIdPart(summary.messageId || `${Date.now()}`)}`;
}

function buildReplyUuid(summary) {
  return `reply:${sanitizeIdPart(summary.messageId || `${Date.now()}`).slice(0, 60)}`;
}

function buildSessionName(summary) {
  return trimString(summary.chatName);
}

function buildSessionDescription(summary) {
  const chatType = trimString(summary?.chatType);
  return chatType ? `Inbound Feishu ${chatType} chat` : 'Inbound Feishu chat';
}

function mentionDisplayName(mention) {
  const name = trimString(mention?.name);
  if (name) return name;
  const token = trimString(mention?.key).replace(/^@+/, '');
  return token || 'user';
}

function renderMentionPreview(text, mentions) {
  let rendered = trimString(text);
  if (!rendered) return '';
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const token = trimString(mention?.key);
    if (!token) continue;
    rendered = rendered.split(token).join(`@${mentionDisplayName(mention)}`);
  }
  return rendered;
}

function buildRemoteLabMessage(summary) {
  const rawMessage = trimString(summary.textPreview);
  const renderedMessage = renderMentionPreview(rawMessage, summary.mentions);
  const displayMessage = renderedMessage || rawMessage || trimString(summary.contentSummary) || '[non-text or empty message]';
  const senderName = trimString(summary?.sender?.name || summary?.sender?.displayName);
  const senderPrefix = summary?.chatType === 'group' && senderName ? `${senderName}: ` : '';
  return `${senderPrefix}${displayMessage}`;
}

function buildSessionSourceContext(summary) {
  const context = {
    connector: 'feishu',
    chatType: trimString(summary?.chatType),
    chatId: trimString(summary?.chatId),
  };
  const chatName = trimString(summary?.chatName);
  if (chatName) context.chatName = chatName;
  return context;
}

function buildMessageSourceContext(summary) {
  const context = {
    connector: 'feishu',
    messageId: trimString(summary?.messageId),
    chatType: trimString(summary?.chatType),
  };
  const senderName = trimString(summary?.sender?.name || summary?.sender?.displayName);
  if (senderName) {
    context.sender = { name: senderName };
  }
  const mentions = (Array.isArray(summary?.mentions) ? summary.mentions : [])
    .map((mention) => {
      const name = mentionDisplayName(mention);
      const token = trimString(mention?.key);
      if (!name && !token) return null;
      return {
        ...(name ? { name } : {}),
        ...(token ? { token } : {}),
      };
    })
    .filter(Boolean);
  if (mentions.length > 0) {
    context.mentions = mentions;
  }
  const contentSummary = trimString(summary?.contentSummary);
  if (contentSummary) {
    context.contentSummary = contentSummary;
  }
  return context;
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
  const eventsResult = await requester(`/api/sessions/${sessionId}/events`);
  if (!eventsResult.response.ok || !Array.isArray(eventsResult.json?.events)) {
    throw new Error(eventsResult.json?.error || eventsResult.text || `Failed to load session events for ${sessionId}`);
  }

  const candidate = await selectAssistantReplyEvent(eventsResult.json.events, {
    match: (event) => (
      (runId && event.runId === runId)
      || (requestId && event.requestId === requestId)
    ),
    hydrate: async (event) => {
      const bodyResult = await requester(`/api/sessions/${sessionId}/events/${event.seq}/body`);
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
  if (!candidate) return null;

  return candidate;
}

function normalizeReplyText(text) {
  const normalized = stripOutboundEmojiArtifacts(stripHiddenBlocks(String(text || '').replace(/\r\n/g, '\n'))).trim();
  if (!normalized) return '';
  if (normalized.length <= MAX_FEISHU_TEXT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_FEISHU_TEXT_LENGTH - 16).trimEnd()}\n\n[truncated]`;
}

function stripOutboundEmojiArtifacts(text) {
  return String(text || '')
    .replace(UNICODE_EMOJI_PATTERN, ' ')
    .replace(FEISHU_EMOJI_ALIAS_PATTERN, ' ')
    .replace(/[\u200D\uFE0E\uFE0F]/g, '')
    .replace(/\s+([,.;:!?，。！？；：、])/g, '$1')
    .replace(/([([{（【])\s+/g, '$1')
    .replace(/\s+([)\]}）】])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

function buildFailureReply(summary, reason = '') {
  const message = trimString(summary?.textPreview || summary?.contentSummary || summary?.rawContent);
  const prefersChinese = containsCjk(message) || containsCjk(reason);
  if (prefersChinese) {
    return '我收到了你的消息，但这次生成回复失败了。你可以稍后再发一次。';
  }
  return 'I received your message, but I could not generate a reply just now. Please try again in a moment.';
}

async function loadHandledMessages(pathname) {
  return await readJson(pathname, { messages: {} });
}

async function wasMessageHandled(pathname, messageId) {
  const state = await loadHandledMessages(pathname);
  return Boolean(state?.messages?.[messageId]);
}

async function markMessageHandled(pathname, messageId, metadata) {
  const state = await loadHandledMessages(pathname);
  state.messages[messageId] = {
    ...(state.messages[messageId] || {}),
    ...metadata,
    handledAt: metadata?.handledAt || nowIso(),
  };
  await writeJson(pathname, state);
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
      appId: config.appId,
      appSecret: config.appSecret,
      domain: resolveDomain(config.region),
      loggerLevel: resolveLoggerLevel(config.loggerLevel),
    }),
    processingMessageIds: new Set(),
    chatQueues: new Map(),
    authToken: '',
    authCookie: '',
  };
}

function enqueueByChat(runtime, summary, worker) {
  const key = summary.chatId || summary.messageId || 'unknown_chat';
  const previous = runtime.chatQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(worker)
    .catch((error) => {
      console.error(`[feishu-connector] queued processing failed for ${summary.messageId || key}:`, error?.stack || error);
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

async function loadRemoteLabEvents(runtime, sessionId) {
  const result = await requestRemoteLab(runtime, `/api/sessions/${sessionId}/events?filter=all`);
  if (!result.response.ok || !Array.isArray(result.json?.events)) {
    throw new Error(result.json?.error || result.text || `Failed to load session events for ${sessionId}`);
  }
  return result.json.events;
}

function sourceContextReferencesRequest(sourceContext, requestId, messageId) {
  if (!sourceContext || typeof sourceContext !== 'object' || Array.isArray(sourceContext)) {
    return false;
  }

  const normalizedRequestId = trimString(requestId);
  const normalizedMessageId = trimString(messageId);
  if (normalizedRequestId && trimString(sourceContext.requestId) === normalizedRequestId) {
    return true;
  }
  if (normalizedMessageId && trimString(sourceContext.messageId) === normalizedMessageId) {
    return true;
  }

  if (!Array.isArray(sourceContext.queuedMessages)) {
    return false;
  }

  return sourceContext.queuedMessages.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (normalizedRequestId && trimString(entry.requestId) === normalizedRequestId) {
      return true;
    }
    return sourceContextReferencesRequest(entry.sourceContext, normalizedRequestId, normalizedMessageId);
  });
}

function findQueuedRequestRunId(events, { requestId, messageId, sinceSeq = 0 } = {}) {
  const normalizedRequestId = trimString(requestId);
  const normalizedMessageId = trimString(messageId);

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'message' || event.role !== 'user') {
      continue;
    }
    if (Number.isInteger(sinceSeq) && Number.isInteger(event.seq) && event.seq <= sinceSeq) {
      continue;
    }

    const runId = trimString(event.runId);
    if (!runId) {
      continue;
    }
    if (normalizedRequestId && trimString(event.requestId) === normalizedRequestId) {
      return runId;
    }
    if (sourceContextReferencesRequest(event.sourceContext, normalizedRequestId, normalizedMessageId)) {
      return runId;
    }
  }

  return '';
}

async function waitForQueuedRequestRun(runtime, sessionId, match = {}) {
  const deadline = Date.now() + RUN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const events = await loadRemoteLabEvents(runtime, sessionId);
    const runId = findQueuedRequestRunId(events, match);
    if (runId) {
      return runId;
    }
    await delay(RUN_POLL_INTERVAL_MS);
  }
  throw new Error(`queued request timed out after ${RUN_POLL_TIMEOUT_MS}ms`);
}

async function createOrReuseSession(runtime, summary, runtimeSelection) {
  const sourceName = runtime.config.region === 'lark-global' ? 'Lark' : 'Feishu';
  const payload = {
    folder: runtime.config.sessionFolder,
    tool: runtimeSelection.tool,
    name: buildSessionName(summary),
    sourceId: 'feishu',
    sourceName,
    group: 'Feishu',
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
  const queued = result.json?.queued === true;
  const duplicate = result.json?.duplicate === true;
  const runId = trimString(result.json?.run?.id);
  if (![200, 202].includes(result.response.status) || (!runId && !queued && !duplicate)) {
    throw new Error(result.json?.error || result.text || `Failed to submit session message (${result.response.status})`);
  }

  return {
    requestId: payload.requestId,
    runId: runId || null,
    duplicate,
    queued,
  };
}

async function waitForRunCompletion(runtime, runId) {
  const deadline = Date.now() + RUN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await requestRemoteLab(runtime, `/api/runs/${runId}`);
    if (!result.response.ok || !result.json?.run) {
      throw new Error(result.json?.error || result.text || `Failed to load run ${runId}`);
    }
    const run = result.json.run;
    if (run.state === 'completed') {
      return run;
    }
    if (['failed', 'cancelled'].includes(run.state)) {
      throw new Error(`run ${run.state}`);
    }
    await delay(RUN_POLL_INTERVAL_MS);
  }
  throw new Error(`run timed out after ${RUN_POLL_TIMEOUT_MS}ms`);
}

function resolveTargetConfigDir(chatBaseUrl) {
  try {
    const normalized = chatBaseUrl?.replace(/\/+$/, '').toLowerCase();
    if (!normalized) return '';
    const registry = loadMailboxRuntimeRegistry();
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
  const targetConfigDir = resolveTargetConfigDir(runtime?.config?.chatBaseUrl);
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

async function generateRemoteLabReply(runtime, summary) {
  const runtimeSelection = await resolveFeishuRuntimeSelection(runtime);
  const session = await createOrReuseSession(runtime, summary, runtimeSelection);
  const readySession = await waitForSessionReady(runtime, session.id, session);
  const baselineSeq = Number.isInteger(readySession?.latestSeq) ? readySession.latestSeq : 0;
  const submission = await submitRemoteLabMessage(runtime, session.id, summary, runtimeSelection);
  let runId = submission.runId;
  if (!runId && submission.queued) {
    runId = await waitForQueuedRequestRun(runtime, session.id, {
      requestId: submission.requestId,
      messageId: summary.messageId,
      sinceSeq: baselineSeq,
    });
  }
  if (!runId && submission.duplicate) {
    return {
      sessionId: session.id,
      runId: '',
      requestId: submission.requestId,
      duplicate: true,
      queued: submission.queued,
      replyText: '',
      silent: true,
    };
  }
  await waitForRunCompletion(runtime, runId);
  const replyEvent = await loadAssistantReply(
    (path) => requestRemoteLab(runtime, path),
    session.id,
    runId,
    submission.requestId,
  );
  const replyText = normalizeReplyText(replyEvent?.content);
  return {
    sessionId: session.id,
    runId,
    requestId: submission.requestId,
    duplicate: submission.duplicate,
    queued: submission.queued,
    replyText,
    silent: !replyText,
  };
}

function resolveMentionTargetId(mention) {
  return trimString(mention?.openId) || trimString(mention?.userId) || trimString(mention?.unionId);
}

function escapeFeishuMentionValue(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function compileFeishuReplyText(text, mentions) {
  let compiled = normalizeReplyText(text);
  const normalizedMentions = (Array.isArray(mentions) ? mentions : [])
    .map((mention) => ({
      mention,
      token: trimString(mention?.key),
      targetId: resolveMentionTargetId(mention),
      displayName: mentionDisplayName(mention),
    }))
    .filter((entry) => entry.targetId && (entry.token || entry.displayName));
  for (const { mention, token, targetId } of normalizedMentions.sort((left, right) => right.token.length - left.token.length)) {
    if (!token) continue;
    const tag = `<at user_id="${escapeFeishuMentionValue(targetId)}">${escapeFeishuMentionValue(mentionDisplayName(mention))}</at>`;
    compiled = compiled.split(token).join(tag);
  }
  for (const { mention, displayName, targetId } of normalizedMentions.sort((left, right) => right.displayName.length - left.displayName.length)) {
    if (!displayName) continue;
    const alias = `@${displayName}`;
    const tag = `<at user_id="${escapeFeishuMentionValue(targetId)}">${escapeFeishuMentionValue(mentionDisplayName(mention))}</at>`;
    compiled = compiled.split(alias).join(tag);
  }
  return compiled;
}

function isProcessingReactionEnabled(runtime) {
  return runtime?.config?.processingReaction?.enabled === true;
}

async function addProcessingReaction(runtime, summary) {
  if (!isProcessingReactionEnabled(runtime)) {
    return null;
  }
  const messageId = trimString(summary?.messageId);
  if (!messageId) {
    return null;
  }
  const emojiType = normalizeReactionEmojiType(runtime?.config?.processingReaction?.emojiType);
  const response = await runtime.appClient.im.v1.messageReaction.create({
    path: {
      message_id: messageId,
    },
    data: {
      reaction_type: {
        emoji_type: emojiType,
      },
    },
  });
  if ((response.code !== undefined && response.code !== 0) || !response.data?.reaction_id) {
    throw new Error(response.msg || 'Failed to add Feishu processing reaction');
  }
  return {
    reactionId: response.data.reaction_id,
    emojiType: response.data?.reaction_type?.emoji_type || emojiType,
  };
}

async function removeProcessingReaction(runtime, summary, reaction) {
  if (runtime?.config?.processingReaction?.removeOnCompletion === false) {
    return false;
  }
  const messageId = trimString(summary?.messageId);
  const reactionId = trimString(reaction?.reactionId);
  if (!messageId || !reactionId) {
    return false;
  }
  const response = await runtime.appClient.im.v1.messageReaction.delete({
    path: {
      message_id: messageId,
      reaction_id: reactionId,
    },
  });
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(response.msg || 'Failed to remove Feishu processing reaction');
  }
  return true;
}

async function sendFeishuText(runtime, summary, text) {
  const response = await runtime.appClient.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: summary.chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: compileFeishuReplyText(text, summary?.mentions) }),
      uuid: buildReplyUuid(summary),
    },
  });
  if ((response.code !== undefined && response.code !== 0) || !response.data?.message_id) {
    throw new Error(response.msg || 'Failed to send Feishu reply');
  }
  return response.data;
}

function isProcessableMessage(summary) {
  if (!summary?.messageId || !summary?.chatId) return false;
  const senderType = trimString(summary?.sender?.senderType).toLowerCase();
  if (senderType && senderType !== 'user') return false;
  return true;
}

function stripMentionTokens(text) {
  return String(text || '').replace(/@_[A-Za-z0-9_]+/g, ' ');
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
  const normalized = normalizeLocalCommandText(summary?.textPreview || summary?.rawContent);
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

async function handleMessage(runtime, summary, sourceLabel, helpers = {}) {
  const wasHandled = helpers.wasMessageHandled || wasMessageHandled;
  const markHandled = helpers.markMessageHandled || markMessageHandled;
  const generateReply = helpers.generateRemoteLabReply || generateRemoteLabReply;
  const sendText = helpers.sendFeishuText || sendFeishuText;
  const addReaction = helpers.addProcessingReaction || addProcessingReaction;
  const removeReaction = helpers.removeProcessingReaction || removeProcessingReaction;

  if (!isProcessableMessage(summary)) {
    return;
  }
  if (runtime.processingMessageIds.has(summary.messageId)) {
    return;
  }
  if (await wasHandled(runtime.storagePaths.handledMessagesPath, summary.messageId)) {
    return;
  }

  runtime.processingMessageIds.add(summary.messageId);
  let processingReaction = null;
  try {
    const messageType = trimString(summary.messageType).toLowerCase();
    if (messageType && messageType !== 'text') {
      await markHandled(runtime.storagePaths.handledMessagesPath, summary.messageId, {
        status: 'silent_no_reply',
        sourceLabel,
        chatId: summary.chatId,
        requestId: buildRequestId(summary),
        reason: 'unsupported_message_type',
        messageType,
        contentSummary: summary.contentSummary || '',
      });
      console.log(`[feishu-connector] no reply sent for ${summary.messageId} (unsupported message type: ${messageType})`);
      return;
    }

    const localCommand = extractLocalCommand(summary);
    if (localCommand) {
      const localResult = await handleLocalCommand(runtime, summary, localCommand, sendText);
      if (localResult?.handled) {
        await markHandled(runtime.storagePaths.handledMessagesPath, summary.messageId, {
          status: localResult.status,
          sourceLabel,
          chatId: summary.chatId,
          localCommand: localResult.commandType,
          responseMessageId: localResult.responseMessageId,
          repliedAt: nowIso(),
        });
        return;
      }
    }

    try {
      processingReaction = await addReaction(runtime, summary);
    } catch (reactionError) {
      console.warn(`[feishu-connector] failed to add processing reaction for ${summary.messageId}: ${reactionError?.message || reactionError}`);
    }

    const generated = await generateReply(runtime, summary);
    const replyText = normalizeReplyText(generated.replyText);
    if (!replyText) {
      const confirmationText = generated.duplicate === true
        ? ''
        : normalizeReplyText(runtime?.config?.silentConfirmationText);
      if (confirmationText) {
        const reply = await sendText(runtime, summary, confirmationText);
        await markHandled(runtime.storagePaths.handledMessagesPath, summary.messageId, {
          status: 'confirmation_sent',
          sourceLabel,
          chatId: summary.chatId,
          sessionId: generated.sessionId,
          runId: generated.runId,
          requestId: generated.requestId,
          duplicate: generated.duplicate,
          reason: 'empty_assistant_reply',
          confirmationText,
          responseMessageId: reply.message_id || '',
          repliedAt: nowIso(),
        });
        console.log(`[feishu-connector] sent confirmation for ${summary.messageId} with ${reply.message_id}`);
        return;
      }
      await markHandled(runtime.storagePaths.handledMessagesPath, summary.messageId, {
        status: 'silent_no_reply',
        sourceLabel,
        chatId: summary.chatId,
        sessionId: generated.sessionId,
        runId: generated.runId,
        requestId: generated.requestId,
        duplicate: generated.duplicate,
        reason: generated.duplicate === true ? 'duplicate_request' : 'empty_assistant_reply',
      });
      console.log(`[feishu-connector] no reply sent for ${summary.messageId} (${generated.duplicate === true ? 'duplicate request' : 'empty assistant reply'})`);
      return;
    }
    const reply = await sendText(runtime, summary, replyText);
    await markHandled(runtime.storagePaths.handledMessagesPath, summary.messageId, {
      status: 'sent',
      sourceLabel,
      chatId: summary.chatId,
      sessionId: generated.sessionId,
      runId: generated.runId,
      requestId: generated.requestId,
      duplicate: generated.duplicate,
      responseMessageId: reply.message_id || '',
      repliedAt: nowIso(),
    });
    console.log(`[feishu-connector] replied to ${summary.messageId} with ${reply.message_id}`);
  } catch (error) {
    console.error(`[feishu-connector] processing failed for ${summary.messageId}:`, error?.stack || error);
    try {
      const fallback = buildFailureReply(summary, error?.message || '');
      const reply = await sendText(runtime, summary, fallback);
      await markHandled(runtime.storagePaths.handledMessagesPath, summary.messageId, {
        status: 'failed_with_notice',
        sourceLabel,
        chatId: summary.chatId,
        error: error?.message || String(error),
        responseMessageId: reply.message_id || '',
        repliedAt: nowIso(),
      });
    } catch (sendError) {
      console.error(`[feishu-connector] fallback send failed for ${summary.messageId}:`, sendError?.stack || sendError);
    }
  } finally {
    if (processingReaction) {
      try {
        await removeReaction(runtime, summary, processingReaction);
      } catch (reactionError) {
        console.warn(`[feishu-connector] failed to remove processing reaction for ${summary.messageId}: ${reactionError?.message || reactionError}`);
      }
    }
    runtime.processingMessageIds.delete(summary.messageId);
  }
}

export {
  DEFAULT_SESSION_SYSTEM_PROMPT,
  buildApprovedChatReply,
  buildChatAccessStatusReply,
  buildRemoteLabMessage,
  buildSessionDescription,
  claimConnectorPidLock,
  compileFeishuReplyText,
  createRuntimeContext,
  ensureAuthCookie,
  ensureAllowedSendersFile,
  extractLocalCommand,
  addProcessingReaction,
  generateRemoteLabReply,
  grantSenderAccess,
  handleChatMemberUserAdded,
  handleMessage,
  isAllowedByPolicy,
  loadPersistedAccessState,
  loadConfig,
  normalizeAllowedSenders,
  normalizeProcessingReactionConfig,
  normalizeReplyText,
  queueAccessStateFlush,
  releaseConnectorPidLock,
  removeProcessingReaction,
  snapshotAccessState,
  summarizeChatMemberUserAddedEvent,
  summarizeEvent,
  upsertApprovedChat,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  const connectorPidLock = await claimConnectorPidLock(config.storageDir);
  process.on('exit', () => {
    releaseConnectorPidLock(connectorPidLock);
  });
  const accessState = await loadPersistedAccessState(config.intakePolicy);
  const storagePaths = {
    eventsLogPath: join(config.storageDir, 'events.jsonl'),
    knownSendersPath: join(config.storageDir, 'known-senders.json'),
    handledMessagesPath: join(config.storageDir, 'handled-messages.json'),
  };
  const runtime = createRuntimeContext(config, storagePaths, accessState);
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
    console.log(`[feishu-connector] closing connection (${reason})`);
    wsClient.close();
  };

  process.on('SIGINT', () => {
    closeConnection('SIGINT');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    closeConnection('SIGTERM');
    process.exit(0);
  });

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const summary = summarizeEvent(data);
      const allowed = await recordInboundEvent(runtime, summary, data, 'im.message.receive_v1');
      if (allowed) {
        enqueueByChat(runtime, summary, () => handleMessage(runtime, summary, 'im.message.receive_v1'));
      }
      return {};
    },
    'im.chat.member.user.added_v1': async (data) => {
      const summary = summarizeChatMemberUserAddedEvent(data);
      enqueueByChat(runtime, { chatId: summary.chatId, messageId: summary.eventId }, () => handleChatMemberUserAdded(runtime, summary, data, 'im.chat.member.user.added_v1'));
      return {};
    },
    message: async (data) => {
      const summary = summarizeLegacyMessageEvent(data);
      const allowed = await recordInboundEvent(runtime, summary, data, 'message');
      if (allowed) {
        enqueueByChat(runtime, summary, () => handleMessage(runtime, summary, 'message'));
      }
      return {};
    },
  });

  await wsClient.start({ eventDispatcher });
  console.log(`[feishu-connector] persistent connection ready (${config.region})`);
  console.log(`[feishu-connector] intake policy: ${config.intakePolicy.mode}`);
  console.log(`[feishu-connector] access state file: ${config.intakePolicy.accessStatePath}`);
  console.log(`[feishu-connector] whitelist mirror: ${config.intakePolicy.allowedSendersPath}`);
  console.log(`[feishu-connector] event log: ${storagePaths.eventsLogPath}`);
  console.log(`[feishu-connector] known senders: ${storagePaths.knownSendersPath}`);
  console.log(`[feishu-connector] handled messages: ${storagePaths.handledMessagesPath}`);
  console.log(`[feishu-connector] RemoteLab base URL: ${config.chatBaseUrl}`);
  console.log(`[feishu-connector] session folder: ${config.sessionFolder}`);
  console.log(
    `[feishu-connector] runtime selection: mode=${config.runtimeSelectionMode} fallbackTool=${config.sessionTool} fallbackModel=${config.model || '(default)'} fallbackEffort=${config.effort || '(default)'} fallbackThinking=${config.thinking ? 'on' : 'off'}`,
  );

  if (options.replayLast) {
    const summary = await loadLatestReplayableSummary(storagePaths.eventsLogPath);
    if (!summary) {
      throw new Error(`No replayable inbound message found in ${storagePaths.eventsLogPath}`);
    }
    console.log(`[feishu-connector] replaying stored message ${summary.messageId}`);
    await handleMessage(runtime, summary, 'replay-last');
    if (options.durationMs === 0) {
      closeConnection('replay complete');
      await delay(250);
      process.exit(0);
    }
  }

  if (options.durationMs > 0) {
    await delay(options.durationMs);
    closeConnection(`duration ${options.durationMs}ms elapsed`);
    await delay(250);
    process.exit(0);
  }

  await new Promise(() => {});
}

if (isMainModule()) {
  main().catch((error) => {
    console.error('[feishu-connector] failed to start:', error?.stack || error?.message || error);
    process.exit(1);
  });
}
