#!/usr/bin/env node
import { sendMemoryReviewCard, handleMemoryReviewCardAction } from '../connectors/feishu/memory-review-cards.mjs';
import { sendAutomationCard, handleAutomationCardAction } from '../connectors/feishu/automation-cards.mjs';
import { freezeLargeSourceContext } from '../chat/source-context-pages.mjs';
import { topicAnnouncementContext } from '../connectors/feishu/group-announcement.mjs';
import { createProjectMemberSync, normalizeProjectMemberSync } from '../connectors/feishu/project-member-sync.mjs';
import { buildFeishuTableCard } from '../connectors/feishu/table-card.mjs';

import { startFeishuWorkboards } from '../connectors/feishu/workboard-component.mjs';
import { defaultFeishuGroupParticipation, normalizeFeishuGroups, resolveFeishuGroupSettings } from '../connectors/feishu/group-settings.mjs';
import { participationEnabled, participationAllowsMessage, createParticipationController, parseParticipationText } from '../connectors/feishu/participation-state.mjs';
import { createPersonalSettingsController, summarizePersonalChatEntered } from '../connectors/feishu/personal-settings-card.mjs';
import { createGroupConfigurationController } from '../connectors/feishu/group-configuration.mjs';
import { startProjectGroupCards } from '../connectors/feishu/project-group-cards.mjs';
import { startFeishuCardRecovery } from '../connectors/feishu/card-startup.mjs';
import { handleFeishuProgressPolicyAction } from '../connectors/feishu/progress-policy-actions.mjs';
import { createFeishuCardReadSampler, handleFeishuCardReadEvent } from '../connectors/feishu/card-engagement.mjs';

import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { performance } from 'node:perf_hooks';
import { basename, dirname, join, resolve } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import * as Lark from '@larksuiteoapi/node-sdk';

import { createKeyedTaskQueue, writeJsonAtomic } from '../chat/fs-utils.mjs';
import { createConnectorInbox } from '../lib/connector-inbox.mjs';
import { createFeishuDisplayEventWriter } from '../lib/feishu-display-events.mjs';
import {
  handleFeishuRuntimeCommands,
  prepareFeishuRuntimeCommandPlan,
  applyFeishuRuntimeCommandPlan,
} from '../connectors/feishu/runtime-commands.mjs';
import { prepareFeishuLogContinuation } from '../connectors/feishu/log-command.mjs';
import { parseFeishuCommandBlock } from '../connectors/feishu/command-parser.mjs';
import { getFeishuConversationSettings, handleFeishuMuteCommand, setFeishuConversationMuted } from '../connectors/feishu/conversation-settings.mjs';
import { startFeishuPrivateConversation, filterPrivateConversationContext } from '../connectors/feishu/private-conversations.mjs';
import { findConnectorMessageIndexRecord } from '../lib/connector-message-index.mjs';
import { createDeliveryReceipts } from '../lib/delivery-receipts.mjs';
import { classifyFeishuDeliveryError, feishuResponseError } from '../connectors/feishu/delivery-errors.mjs';
import { AUTH_FILE, CHAT_PORT, CONFIG_DIR } from '../lib/config.mjs';
import { readServiceToken } from '../lib/auth-config.mjs';
import {
  normalizeExternalRuntimeOverride,
  normalizeExternalRuntimeSelectionMode,
  resolveExternalRuntimeSelection,
} from '../lib/external-runtime-selection.mjs';
import {
  buildInstanceRuntimeCellEnvironment,
  ensureInstanceLarkCliBotProfile,
} from '../lib/instance-runtime-cell.mjs';
import { getAutoRuntimeSelection } from '../lib/runtime-selection.mjs';
import {
  DEFAULT_FEISHU_SESSION_SYSTEM_PROMPT as DEFAULT_SESSION_SYSTEM_PROMPT,
  FEISHU_CONNECTOR_ID,
  FEISHU_CONNECTOR_NAME,
  LARK_CONNECTOR_NAME,
  LEGACY_DEFAULT_FEISHU_SESSION_SYSTEM_PROMPT as LEGACY_DEFAULT_SESSION_SYSTEM_PROMPT,
  buildAttributedFeishuMessage,
  buildExternalTriggerId,
  buildFeishuApiUuid,
  buildFeishuPostContent,
  buildFeishuTopicId,
  buildMessageSourceContext,
  buildRemoteLabMessage,
  buildRequestId,
  buildSessionDescription,
  buildSessionSourceContext,
  compileFeishuReplyText,
  cleanFeishuReplyText,
  MAX_FEISHU_TEXT_LENGTH,
  isFeishuDocumentCommentSummary,
  isFeishuTopicChat,
  isFeishuTopicGroup,
  normalizeFeishuMode,
  normalizeReplyText,
  sanitizeIdPart,
  shouldReplyInFeishuThread,
  shouldReplyToFeishuMessage,
  summarizeFeishuEvent as summarizeEvent,
  summarizeFeishuEventForLog as summarizeEventForLog,
} from '../connectors/feishu/index.mjs';
import {
  loadFeishuConversationContext,
} from '../connectors/feishu/conversation-context.mjs';
import {
  appendLinkedFeishuProjectDelivery,
  appendLinkedFeishuProjectEvent,
  loadLinkedFeishuProjectContext,
  normalizeFeishuProjectLinks,
} from '../connectors/feishu/linked-project-context.mjs';
import {
  buildFeishuSessionReactionContext,
  classifyFeishuQuickParticipation,
  createFeishuQuickParticipationPilot,
} from '../connectors/feishu/quick-participation.mjs';
import { createFeishuReadReactionStore, createFeishuOutcomeReactionStore } from '../connectors/feishu/read-reactions.mjs';
import { FEISHU_SOCIAL_REACTION_CRITERIA, normalizeFeishuReactionCandidates } from '../lib/feishu-reaction-catalog.mjs';
import { sendNativeQuestionCard, handleNativeQuestionCardAction } from '../connectors/feishu/native-question-cards.mjs';
import { createDiscussionHandoffPilot, discussionHandoffLink } from '../connectors/feishu/discussion-handoff.mjs';
import { createProjectSurface } from '../connectors/feishu/project-surface.mjs';
import { summarizeFeishuReactionFeedback } from '../connectors/feishu/reaction-mute.mjs';
import { startDocumentBindingEvents } from '../connectors/feishu/document-bindings.mjs';
import {
  hydrateFeishuDocumentCommentSummary,
  addFeishuCommentProcessingReaction,
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
import { normalizeFeishuReplyPolicy } from '../connectors/feishu/reply-policy.mjs';
import {
  applyFeishuReplyRouting,
  buildFeishuRequestDeliveryTarget,
  buildFeishuSessionConversationTarget,
  buildFeishuSessionExternalTriggerId,
  isFeishuThreadConversation,
} from '../connectors/feishu/reply-routing.mjs';
import { createFeishuHttpInstance } from '../lib/feishu-http-client.mjs';
import { createFeishuMeetingObserver } from '../connectors/feishu/meeting-observer.mjs';
import { createFeishuMeetingIngest } from '../connectors/feishu/meeting-ingest.mjs';
import { loadReplayableSummariesByMessageIds } from '../lib/feishu-replay.mjs';
import {
  normalizeFeishuResponsePolicy,
  isFeishuBotSender,
  mentionsFeishuBot,
  resolveFeishuBotIdentity,
  shouldRouteFeishuMessageToRemoteLab,
} from '../connectors/feishu/response-policy.mjs';
import {
  claimFeishuBotHandoff, recordFeishuBotHandoffScope, normalizeFeishuBotHandoffPolicy,
  restoreFeishuBotHandoffScopes, withFeishuHandoffLock,
} from '../connectors/feishu/bot-handoff.mjs';
import {
  createConnectorSession,
  submitConnectorMessage,
} from '../lib/connector-turn-flow.mjs';
import { isQuickSession } from '../lib/quick-session-profile.mjs';
import {
  findFeishuSessionBinding, findFeishuThreadSessionBinding, resolveFeishuReferencedTopic,
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
const DEFAULT_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
const DEFAULT_SOURCE_DELIVERY_LONG_POLL_MS = 20_000;
const DEFAULT_SOURCE_DELIVERY_RETRY_MS = 1000;
const DEFAULT_SESSION_TOOL = 'codex';
const DEFAULT_RUNTIME_SELECTION_MODE = 'ui';
const DEFAULT_FEISHU_API_TIMEOUT_MS = 10_000;
const DEFAULT_PROCESSING_REACTION_TIMEOUT_MS = 10_000;
const CONNECTOR_PID_FILENAME = 'connector.pid';
const QUICK_PROFILE_CONFLICT = 'FEISHU_QUICK_PROFILE_CONFLICT';
const updateSenderIndex = createKeyedTaskQueue();

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
    "responsePolicy": {
      "group": "mention_only"
    },
    "accessPolicy": {
      "mode": "all",
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

function normalizeAccessPolicy(value, options = {}) {
  const mode = trimString(value?.mode || 'all').toLowerCase();
  if (!['all', 'whitelist'].includes(mode)) {
    throw new Error(`Unsupported accessPolicy.mode: ${value?.mode || '(missing)'}`);
  }

  const baseDir = options.baseDir || homedir();
  const defaultAllowedSendersPath = options.defaultAllowedSendersPath || join(baseDir, DEFAULT_ALLOWED_SENDERS_FILENAME);
  return {
    mode,
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

function normalizePositiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
  if (parsed.defaultGroupParticipation !== undefined && !['active', 'listening', 'paused', 'mention_only'].includes(parsed.defaultGroupParticipation)) {
    throw new Error('defaultGroupParticipation must be active or paused (legacy values are read for migration)');
  }
  if (parsed.jevReactions !== undefined && typeof parsed.jevReactions !== 'boolean') {
    throw new Error('jevReactions must be boolean');
  }
  for (const legacyKey of ['intakePolicy', 'groupReplyPolicy', 'sessionPolicy', 'processingReaction', 'silentConfirmationText']) {
    if (Object.hasOwn(parsed, legacyKey)) {
      throw new Error(`Unsupported legacy Feishu config key ${legacyKey}; use accessPolicy, responsePolicy and replyPolicy`);
    }
  }
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
    responsePolicy: normalizeFeishuResponsePolicy(parsed?.responsePolicy),
    groups: normalizeFeishuGroups(parsed?.groups),
    defaultGroupParticipation: defaultFeishuGroupParticipation(parsed),
    jevReactions: parsed.jevReactions !== false,
    groupReactionCandidates: normalizeFeishuReactionCandidates(parsed.groupReactionCandidates),
    projectLinks: normalizeFeishuProjectLinks(parsed?.projectLinks),
    projectMemberSync: normalizeProjectMemberSync(parsed?.projectMemberSync),
    projectCards: parsed.projectCards === true,
    personalSettings: {
      enabled: parsed.personalSettings?.enabled === true,
      openIds: Array.isArray(parsed.personalSettings?.openIds) ? parsed.personalSettings.openIds.filter(x => typeof x === 'string' && /^ou_[a-zA-Z0-9]+$/.test(x)) : [],
      webUrl: trimString(parsed.personalSettings?.webUrl),
    },
    projectSurfacesPath: trimString(parsed?.projectSurfacesPath)
      ? resolve(configDir, parsed.projectSurfacesPath) : '',
    replyPolicy: normalizeFeishuReplyPolicy(parsed?.replyPolicy),
    botHandoffPolicy: normalizeFeishuBotHandoffPolicy(parsed?.botHandoffPolicy),
    accessPolicy: normalizeAccessPolicy(parsed?.accessPolicy, {
      baseDir: configDir,
      defaultAllowedSendersPath: join(configDir, DEFAULT_ALLOWED_SENDERS_FILENAME),
    }),
    storeRawEvents: parsed?.storeRawEvents === true,
    chatBaseUrl: normalizeBaseUrl(parsed?.chatBaseUrl || DEFAULT_CHAT_BASE_URL),
    sessionFolder: trimString(parsed?.sessionFolder) || homedir(),
    runtimeSelectionMode: normalizeExternalRuntimeSelectionMode(parsed?.runtimeSelectionMode, DEFAULT_RUNTIME_SELECTION_MODE),
    groupMainlineRuntimeSelection: normalizeExternalRuntimeOverride(parsed?.groupMainlineRuntimeSelection ?? null),
    sessionTool: trimString(parsed?.sessionTool) || DEFAULT_SESSION_TOOL,
    model: trimString(parsed?.model),
    effort: trimString(parsed?.effort),
    thinking: normalizeBoolean(parsed?.thinking, false),
    systemPrompt: normalizeSystemPrompt(parsed?.systemPrompt),
    sourceRouteId,
  };
}

async function initializeFeishuInstanceRuntime(config, options = {}) {
  const instanceRoot = trimString(process.env.REMOTELAB_INSTANCE_ROOT)
    || trimString(config?.sessionFolder)
    || homedir();
  const profileName = trimString(config?.sourceRouteId) || 'default';
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
    profileName,
    configDir: trimString(process.env.LARKSUITE_CLI_CONFIG_DIR)
      || runtimeCellEnvironment.LARKSUITE_CLI_CONFIG_DIR,
    legacyConfigDir: trimString(config?.storageDir)
      ? join(config.storageDir, 'lark-cli', profileName)
      : '',
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
  return {
    allowedSenders: await ensureAllowedSendersFile(policy.allowedSendersPath, policy.allowedSenders),
  };
}

async function loadEffectiveAllowedSenders(policy) {
  const fileState = await readAllowedSendersFile(policy.allowedSendersPath);
  if (fileState.status === 'ok' && fileState.allowedSenders) {
    return fileState.allowedSenders;
  }
  return normalizeAllowedSenders(policy.allowedSenders);
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
  return updateSenderIndex(resolve(pathname), async () => {
    const current = await readJson(pathname, { senders: {} });
    const incoming = senderIdentity(summary);
    const key = senderKey(incoming);
    current.senders[key] = mergeSenderIdentity(current.senders[key], incoming);
    await writeJsonAtomic(pathname, current);
  });
}

async function isAllowedByPolicy(policy, summary) {
  if (policy.mode !== 'whitelist') return true;
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
  await appendLinkedFeishuProjectEvent(runtime, record);
  console.log(`[feishu-connector] inbound event ${sourceLabel} (${allowed ? 'allowed' : 'blocked'})`, JSON.stringify(summarizeEventForLog(summary)));
  return allowed;
}

async function recordInboundEvent(runtime, summary, raw, sourceLabel) {
  const allowed = await isAllowedByPolicy(runtime.config.accessPolicy, summary);
  const linkedHumanMessage = allowed
    && trimString(summary?.sender?.senderType).toLowerCase() === 'user'
    && runtime.config.projectLinks?.some(link => link.discussionChatId === summary.chatId
      || link.workChatId === summary.chatId);
  const recordedSummary = linkedHumanMessage
    ? await enrichSummaryWithSenderProfile(runtime, summary) : summary;
  await recordConnectorEvent(runtime, sourceLabel, recordedSummary, raw, allowed);
  await updateKnownSenders(runtime.storagePaths.knownSendersPath, recordedSummary);
  if (!allowed) {
    console.log('[feishu-connector] sender blocked by whitelist policy');
  }
  return allowed;
}

function buildSessionName() {
  return '';
}

async function readConnectorToken() {
  return readServiceToken(AUTH_FILE);
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

async function requestJson(baseUrl, path, { method = 'GET', cookie, body, signal } = {}) {
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
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
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

function createRuntimeContext(config, storagePaths) {
  const runtime = {
    config,
    storagePaths,
    appClient: new Lark.Client({
      httpInstance: createFeishuHttpInstance(Lark.defaultHttpInstance, 30000, {
        appId: config.appId, sourceRouteId: config.sourceRouteId, component: 'connector',
      }),
      appId: config.appId,
      appSecret: config.appSecret,
      domain: resolveDomain(config.region),
      loggerLevel: resolveLoggerLevel(config.loggerLevel),
    }),
    chatMetadataCache: new Map(),
    userProfileCache: new Map(),
    botIdentity: null,
    authToken: '',
    authCookie: '',
  };
  runtime.requestRemoteLab = (path, options) => requestRemoteLab(runtime, path, options);
  return runtime;
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
      // Chat API chat_type means private/public visibility, not IM group/p2p.
      chatType: response.data?.chat_mode === 'p2p' ? 'p2p'
        : ['group', 'topic'].includes(response.data?.chat_mode) ? 'group' : '',
    };
    runtime.chatMetadataCache.set(normalizedChatId, metadata);
    return metadata;
  } catch (error) {
    console.warn(`[feishu-connector] failed to load chat metadata for ${normalizedChatId}: ${error?.message || error}`);
    runtime.chatMetadataCache.set(normalizedChatId, null);
    return null;
  }
}

// Restored records and synthetic delivery/card targets may describe a reply
// thread rather than the provider's chat type. Resolve that boundary once using
// the shared chat metadata cache before applying group participation controls.
async function resolveFeishuGroupSource(runtime, summary) {
  if (['p2p', 'private'].includes(summary?.chatType)) return summary;
  const metadata = await loadFeishuChatMetadata(runtime, summary?.chatId);
  return metadata ? { ...summary,
    chatType: metadata.chatType || summary.chatType || 'group',
    chatMode: metadata.chatMode || summary.chatMode,
    groupMessageType: metadata.groupMessageType || '',
  } : summary;
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

async function loadFeishuUserProfile(runtime, openId) {
  const normalizedOpenId = trimString(openId);
  if (!normalizedOpenId || !runtime?.appClient?.contact?.v3?.user?.get) return null;
  if (!runtime.userProfileCache) runtime.userProfileCache = new Map();
  if (runtime.userProfileCache.has(normalizedOpenId)) {
    return await runtime.userProfileCache.get(normalizedOpenId);
  }

  const pending = (async () => {
    try {
      const timeoutMs = Math.min(
        normalizePositiveTimeout(runtime?.config?.apiTimeoutMs, DEFAULT_FEISHU_API_TIMEOUT_MS),
        5_000,
      );
      const response = await withTimeout(
        () => runtime.appClient.contact.v3.user.get({
          params: { user_id_type: 'open_id' },
          path: { user_id: normalizedOpenId },
        }),
        timeoutMs,
        'Feishu user profile lookup',
      );
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(response.msg || `Failed to load Feishu user profile (${response.code})`);
      }
      const user = response.data?.user || response.data || {};
      const profile = {
        name: trimString(user.name || user.nickname),
        englishName: trimString(user.en_name),
      };
      return profile.name || profile.englishName ? profile : null;
    } catch (error) {
      console.warn(`[feishu-connector] failed to load user profile for ${normalizedOpenId}: ${error?.message || error}`);
      return null;
    }
  })();
  runtime.userProfileCache.set(normalizedOpenId, pending);
  const profile = await pending;
  runtime.userProfileCache.set(normalizedOpenId, profile);
  return profile;
}

async function enrichSummaryWithSenderProfile(runtime, summary) {
  if (!summary || typeof summary !== 'object') return summary;
  const sender = summary.sender && typeof summary.sender === 'object' ? summary.sender : {};
  if (trimString(sender.senderType).toLowerCase() !== 'user') return summary;
  const profile = await loadFeishuUserProfile(runtime, sender.openId);
  if (!profile) return summary;
  return {
    ...summary,
    sender: {
      ...sender,
      name: trimString(sender.name) || profile.name || profile.englishName,
      englishName: trimString(sender.englishName) || profile.englishName,
    },
  };
}

async function reconcileKnownFeishuPeople(runtime) {
  const knownSendersPath = trimString(runtime?.storagePaths?.knownSendersPath);
  if (!knownSendersPath) return { checked: 0, matched: 0 };
  let records = [];
  try {
    const stored = JSON.parse(await readFile(knownSendersPath, 'utf8'));
    records = Object.values(stored?.senders || {}).filter((sender) => (
      trimString(sender?.senderType).toLowerCase() === 'user'
      && trimString(sender?.openId)
      && trimString(sender?.userId)
    ));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { checked: 0, matched: 0 };
  }

  let cursor = 0;
  let matched = 0;
  const workerCount = Math.min(4, records.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < records.length) {
      const sender = records[cursor];
      cursor += 1;
      const enriched = await enrichSummaryWithSenderProfile(runtime, { sender });
      const resolved = await requestRemoteLab(runtime, '/api/people/reconcile-external-identity', {
        method: 'POST',
        body: {
          kind: FEISHU_CONNECTOR_ID,
          realm: runtime.config.sourceRouteId || 'default',
          subjectId: sender.openId,
          stableSubjectId: sender.unionId || sender.userId || sender.openId,
          displayName: enriched?.sender?.name || '',
          englishName: enriched?.sender?.englishName || '',
        },
      });
      if (!resolved.response.ok) {
        throw new Error(resolved.json?.error || `RemoteLab identity reconciliation failed (${resolved.response.status})`);
      }
      if (resolved.json?.matched === true) matched += 1;
    }
  }));
  return { checked: records.length, matched };
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
    runtime.authToken = typeof runtime.readServiceToken === 'function'
      ? await runtime.readServiceToken()
      : await readConnectorToken();
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

async function resolveFeishuRuntimeSelection(runtime, summary = {}) {
  if (summary.chatType === 'group' && summary.conversationKind === 'main'
      && runtime?.config?.groupMainlineRuntimeSelection) {
    return { mode: 'pinned', ...runtime.config.groupMainlineRuntimeSelection };
  }
  const uiSelection = getAutoRuntimeSelection();
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

async function submitRemoteLabRequest(runtime, summary, {
  prepared = null, saveSubmission = async () => {}, observeOnly = false, skipUserMessage = false,
  observedSessionId = null,
  observedAttachments = null,
} = {}) {
  const requester = (path, options = {}) => requestRemoteLab(runtime, path, options);
  if (prepared?.mode) observeOnly = prepared.mode === 'observe';
  if (observeOnly) return { ignored: true, reason: 'listening_retired' };
  if (participationEnabled(runtime, summary)) {
    const state = await participationController(runtime).state(summary);
    const epoch = prepared?.payload?.sourceDelivery?.target?.participationEpoch ?? summary.participationEpoch;
    if ((epoch !== undefined && Number(epoch) !== state.epoch)
        || !participationAllowsMessage(state, summary)) {
      return { ignored: true, reason: 'participation_changed' };
    }
  }
  if (prepared) {
    let submission;
    try {
      submission = await submitConnectorMessage(requester, prepared.sessionId, {
      ...prepared.payload,
      // A pre-upgrade prepared worker submission owns its original topology.
      // Its user event has not been observed in the mainline Session.
      ...(skipUserMessage && (!observedSessionId || prepared.sessionId === observedSessionId)
        ? { recordUserMessage: false } : {}),
      });
    } catch (error) {
      // Current origin-backed topics continue after Run completion. An expired
      // legacy run-only packet has no proven new owner: retain its preparation
      // for repair instead of silently creating a different Session.
      if (error.code === 'THREAD_CONTINUATION_EXPIRED') error.retryable = false;
      throw error;
    }
    return { ...prepared.receipt, sessionId: prepared.sessionId, runId: submission.runId,
      requestId: submission.requestId, responseId: submission.responseId,
      duplicate: submission.duplicate, queued: submission.queued };
  }
  const summaryWithChatMetadata = await enrichSummaryWithChatMetadata(runtime, summary);
  const effectiveSummary = applyFeishuReplyRouting(runtime.config, {
    ...await enrichSummaryWithSenderProfile(runtime, summaryWithChatMetadata),
    sourceRouteId: runtime.config.sourceRouteId,
  });
  await runtime.groupConfiguration?.reload(effectiveSummary.chatId);
  const groupSettings = resolveFeishuGroupSettings(runtime.config, effectiveSummary);
  const ambient = groupSettings.participationMode === 'ambient'
    && effectiveSummary.conversationKind === 'main'
    && !effectiveSummary.replyModeOverride;
  const soleMention = ambient && mentionsFeishuBot(runtime, effectiveSummary)
    && !stripLeadingMentionTokens(effectiveSummary.messageText || effectiveSummary.textPreview || '').trim();
  const isQuickCommand = effectiveSummary.quickMode === true;
  const baseExternalTriggerId = buildFeishuSessionExternalTriggerId(
    effectiveSummary,
    runtime.config.sourceRouteId || 'default',
  );
  const groupFeed = groupSettings.groupFeed === true && ambient;
  const groupFeedRollback = groupSettings.groupFeed === false && ambient;
  const externalTriggerId = groupFeed
    ? baseExternalTriggerId.replace('feishu:main:', 'feishu:group-feed:')
    : groupFeedRollback
      ? baseExternalTriggerId.replace('feishu:main:', 'feishu:legacy-return:')
    : baseExternalTriggerId;
  const groupFeedFolder = join(homedir(), '.remotelab', 'workspace', 'group-feed',
    runtime.config.sourceRouteId || 'default', effectiveSummary.chatId);
  if (groupFeed) await mkdir(groupFeedFolder, { recursive: true, mode: 0o700 });
  const runtimeSelection = effectiveSummary.runtimeSelectionOverride
    || await resolveFeishuRuntimeSelection(runtime, effectiveSummary);
  const sessionPayload = {
    folder: groupFeed ? groupFeedFolder : runtime.config.sessionFolder,
    tool: runtimeSelection.tool,
    name: buildSessionName(effectiveSummary),
    sourceId: FEISHU_CONNECTOR_ID,
    sourceName: runtime.config.region === 'lark-global' ? LARK_CONNECTOR_NAME : FEISHU_CONNECTOR_NAME,
    group: FEISHU_CONNECTOR_NAME,
    description: buildSessionDescription(effectiveSummary),
    systemPrompt: groupSettings.systemPrompt,
    conversation: {
      connector: 'feishu',
      sourceRouteId: runtime.config.sourceRouteId || 'default',
      target: buildFeishuSessionConversationTarget(effectiveSummary),
    },
    externalTriggerId,
    ...(groupFeed ? { groupFeed: true } : {}),
    sourceContext: buildSessionSourceContext(effectiveSummary),
    ...(isQuickCommand ? { executionProfile: 'quick' } : {}),
    ...(runtimeSelection.model ? { model: runtimeSelection.model } : {}),
    ...(runtimeSelection.effort ? { effort: runtimeSelection.effort } : {}),
    ...(runtimeSelection.thinking ? { thinking: true } : {}),
  };
  const threadBinding = effectiveSummary.logContinuation?.sessionId
    ? { sessionId: effectiveSummary.logContinuation.sessionId }
    : await findFeishuSessionBinding(runtime, effectiveSummary);
  let session;
  if (threadBinding?.sessionId) {
    const result = await requester(`/api/sessions/${encodeURIComponent(threadBinding.sessionId)}`);
    if (!result.response?.ok || !result.json?.session?.id) {
      throw new Error(result.json?.error || `Unable to read bound Session (${result.response?.status || 'unknown'})`);
    }
    session = result.json.session;
    const configuredSystemPrompt = sessionPayload.systemPrompt.trim();
    const currentSystemPrompt = typeof session.systemPrompt === 'string' ? session.systemPrompt.trim() : '';
    if (!threadBinding.continuationRunId && !threadBinding.threadOriginRunId && !isQuickSession(session) && configuredSystemPrompt !== currentSystemPrompt) {
      const updated = await requester(`/api/sessions/${encodeURIComponent(threadBinding.sessionId)}`, {
        method: 'PATCH',
        body: { systemPrompt: configuredSystemPrompt },
      });
      if (!updated.response?.ok || !updated.json?.session?.id) {
        throw new Error(updated.json?.error || `Unable to update bound Session instructions (${updated.response?.status || 'unknown'})`);
      }
      session = updated.json.session;
    }
  } else {
    session = await createConnectorSession(requester, sessionPayload);
  }
  // Group prompt edits apply to an existing mainline as well as bound topics.
  // Never mutate an already accepted Run's prompt snapshot.
  if (runtime.groupConfiguration && !threadBinding?.continuationRunId && !threadBinding?.threadOriginRunId && !isQuickSession(session)
      && (session.systemPrompt || '').trim() !== sessionPayload.systemPrompt.trim()) {
    const updated = await requester(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH', body: { systemPrompt: sessionPayload.systemPrompt },
    });
    if (!updated.response?.ok || !updated.json?.session?.id) throw new Error(updated.json?.error || 'Unable to apply group prompt');
    session = updated.json.session;
  }
  if (isQuickCommand && !isQuickSession(session)) {
    throw Object.assign(new Error('Quick profile conflicts with the Session already bound to this conversation'), {
      code: QUICK_PROFILE_CONFLICT,
    });
  }
  // Participation changes execution, never the resource ingestion contract.
  const attachmentsPromise = observedSessionId === session.id && observedAttachments
    ? Promise.resolve(observedAttachments)
    : resolveFeishuMessageAttachments(runtime, effectiveSummary, { sessionId: session.id });
  const participationStatus = participationEnabled(runtime, effectiveSummary)
    ? await participationController(runtime).state(effectiveSummary) : null;
  const [attachmentResolution, conversationContext, linkedProjectContext, groupAnnouncement] = await Promise.all([
    attachmentsPromise,
    // Select the recent activity/topic window. Preparation bounds group text
    // before delivery dedup; raw selected bodies remain in the source snapshot.
    loadFeishuConversationContext(runtime, effectiveSummary, {
      includeMetadata: true, deferBudget: true,
      complete: ['p2p', 'private'].includes(effectiveSummary.chatType),
      ...(session.privateConversationStart ? { sinceTimeMs: session.privateConversationStart.at,
        sinceMessageId: session.privateConversationStart.messageId } : {}),
    }).then(context => filterPrivateConversationContext(runtime, effectiveSummary, session, context))
      .catch((error) => {
        console.warn(`[feishu-connector] failed to load conversation context for ${effectiveSummary.messageId}: ${error?.message || error}`);
        return { messages: [], truncated: true, error: String(error?.message || error) };
      }),
    loadLinkedFeishuProjectContext(runtime, effectiveSummary).catch((error) => {
      console.warn(`[feishu-connector] failed to load linked project context for ${effectiveSummary.messageId}: ${error?.message || error}`);
      return null;
    }),
    topicAnnouncementContext(runtime, effectiveSummary, session.id),
  ]);
  const messageSummary = {
    ...effectiveSummary,
    ...(conversationContext ? { conversationContext } : {}),
    ...(linkedProjectContext ? { linkedProjectContext } : {}),
    ...(groupAnnouncement ? { groupAnnouncement } : {}),
    ...(attachmentResolution.failures.length > 0
      ? { attachmentDownloadFailures: attachmentResolution.failures }
      : {}),
  };
  // Session identity follows main-vs-thread topology. Each request still owns
  // an immutable delivery snapshot so delayed replies return to the location
  // selected for that inbound message.
  const deliverySummary = { ...messageSummary, ...(participationStatus
    ? { participationEpoch: String(effectiveSummary.participationEpoch ?? participationStatus.epoch) } : {}) };
  const requestDeliveryTarget = buildFeishuRequestDeliveryTarget(deliverySummary);
  const payload = {
    requestId: buildRequestId(effectiveSummary),
    text: messageSummary.logContinuation
      ? buildAttributedFeishuMessage({ ...messageSummary, messageText: messageSummary.messageText })
      : soleMention
        ? buildAttributedFeishuMessage({ ...messageSummary,
          messageText: '[群聊反馈：用户只 @ 了你。请重新审视最近仍未得到你回应的几条消息，结合后续讨论判断现在是否应该回复；没有必要时保持沉默。]' })
        : buildAttributedFeishuMessage(messageSummary),
    tool: runtimeSelection.tool,
    runtimeSelectionScope: 'auto',
    sourceContext: {
      ...buildMessageSourceContext(messageSummary),
      ...(groupSettings.selfReview ? { groupSelfReview: { enabled: true,
        revision: groupSettings.selfReviewRevision } } : {}),
      ...(!['p2p', 'private'].includes(messageSummary.chatType) && !isFeishuBotSender(messageSummary)
        ? { feishuResponseProtocolVersion: 1, feishuProcessingReaction: groupSettings.processingReactions } : {}),
      ...(threadBinding?.threadOriginRunId ? { feishuThreadOriginRunId: threadBinding.threadOriginRunId } : {}),
      ...(threadBinding?.continuationRunId ? { feishuContinuationRunId: threadBinding.continuationRunId } : {}),
      ...(messageSummary.logContinuation ? { feishuLog: {
        sessionId: messageSummary.logContinuation.sessionId,
        runId: messageSummary.logContinuation.runId,
      } } : {}),
      ...(ambient ? {
        feishuParticipation: 'ambient',
        feishuReplyPlacementVersion: 1,
        feishuThreadSessionVersion: 1,
        feishuExplicitMention: mentionsFeishuBot(runtime, effectiveSummary),
        ...(soleMention ? { feishuFeedback: 'reconsider_unanswered' } : {}),
      } : {}),
    },
    sourceDelivery: {
      connector: 'feishu',
      sourceRouteId: runtime.config.sourceRouteId || 'default',
      target: requestDeliveryTarget,
    },
    ...(attachmentResolution.attachments.length > 0 ? { attachments: attachmentResolution.attachments } : {}),
    ...(runtimeSelection.thinking ? { thinking: true } : {}),
    ...(runtimeSelection.model ? { model: runtimeSelection.model } : {}),
    ...(runtimeSelection.effort ? { effort: runtimeSelection.effort } : {}),
  };
  if (effectiveSummary.participationOnce) {
    payload.text = '[当前范围已暂停接收。用户仅邀请你处理这一次；完成后保持暂停。]\n' + payload.text;
    payload.sourceContext.feishuParticipationMode = 'paused';
  } else if (participationStatus) {
    payload.sourceContext.feishuParticipationMode = participationStatus.mode;
  }
  if (groupSettings.jevReactions) {
    const outcomes = runtime.outcomeReactionStore ||= createFeishuOutcomeReactionStore(runtime.config.storageDir);
    // Preparation may overlap Jev. A local receipt read must not await its job
    // or retry admission when feedback is unavailable.
    payload.sourceContext.feishuReactionReceipt = await outcomes.snapshot(effectiveSummary.messageId)
      .catch(() => ({ status: 'unavailable', checkedAt: new Date().toISOString() }));
  }
  payload.sourceContext = await freezeLargeSourceContext(session.id, payload.sourceContext);
  const handoff = { mode: 'execute', sessionId: session.id, summary: effectiveSummary, payload, receipt: {
    externalTriggerId, attachmentCount: attachmentResolution.attachments.length,
    attachmentDownloadFailureCount: attachmentResolution.failures.length,
  } };
  await recordFeishuBotHandoffScope(runtime, effectiveSummary, { sessionId: session.id });
  await saveSubmission(handoff);
  return submitRemoteLabRequest(runtime, summary, { prepared: handoff, saveSubmission, skipUserMessage });
}

async function enqueueJevOutcomeReaction(runtime, summary, sessionId, emojiType) {
  const delivery = await requestRemoteLab(runtime, '/api/source-deliveries', {
    method: 'POST', body: {
      sessionId,
      responseId: `feishu-jev:${summary.messageId}`,
      reaction: emojiType,
      sourceDelivery: {
        connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId || 'default',
        target: buildFeishuRequestDeliveryTarget(summary),
      },
    },
  });
  if (!delivery.response.ok || !delivery.json?.delivery?.id) {
    throw new Error(delivery.json?.error || 'Unable to queue Jev reaction');
  }
  return delivery.json.delivery;
}

// Optional feedback has its own lifetime. Its failure must not retry or delay
// admission. Once selected, the existing observation and outbox make it durable.
function startJevReaction(runtime, summary, receipt, helpers, controller) {
  const jobs = runtime.jevReactionJobs ||= new Map();
  const key = `${summary.chatId}:${summary.messageId}`;
  if (jobs.has(key)) return;
  const { sessionId } = receipt;
  const job = Promise.resolve().then(async () => {
    const observation = receipt.observation || await (helpers.loadAcceptedObservation || (async (_runtime, _summary, accepted) => {
      const result = await requestRemoteLab(runtime, `/api/sessions/${encodeURIComponent(accepted.sessionId)}/observations`, {
        method: 'POST', body: { acceptedRequestId: accepted.requestId },
      });
      if (!result.response.ok) throw new Error(result.json?.error || 'Unable to read accepted input for feedback');
      return result.json;
    }))(runtime, summary, receipt);
    let decision = observation.decision;
    if (!decision) {
      const verdict = await (helpers.classifyJevReaction || classifyFeishuQuickParticipation)(
        buildFeishuSessionReactionContext(observation.recent, { mentioned: mentionsFeishuBot(runtime, summary) }),
        { reactionCandidates: resolveFeishuGroupSettings(runtime.config, summary).reactionCandidates });
      const emojiType = Object.hasOwn(FEISHU_SOCIAL_REACTION_CRITERIA, verdict?.emojiType || '')
        ? verdict.emojiType : null;
      const saved = await (helpers.recordJevDecision || ((id, sourceMessageId, value) =>
        requestRemoteLab(runtime, `/api/sessions/${encodeURIComponent(id)}/observations/decision`, {
          method: 'POST', body: { sourceMessageId, ...value },
        })))(sessionId, summary.messageId, { purpose: 'reaction', emojiType, reason: verdict?.reason || '',
          ...(verdict?.diagnostics ? { diagnostics: verdict.diagnostics } : {}) });
      if (saved?.response && !saved.response.ok) throw new Error(saved.json?.error || 'Unable to record reaction');
      decision = saved?.json?.decision || saved?.decision;
      if (!decision) throw new Error('Reaction was not durably recorded');
    }
    // Legacy decisions may contain work, binary-answer or control judgments.
    // None of them authorizes admission, placement or a factual emoji answer.
    if (!Object.hasOwn(FEISHU_SOCIAL_REACTION_CRITERIA, decision.emojiType || '')
        || !resolveFeishuGroupSettings(runtime.config, summary).reactionCandidates.includes(decision.emojiType)) return;
    if (controller) {
      const latest = await controller.state(summary);
      if (Number(summary.participationEpoch) !== latest.epoch || !participationAllowsMessage(latest, summary)) return;
    }
    await (helpers.enqueueJevReaction || enqueueJevOutcomeReaction)(runtime, summary, sessionId, decision.emojiType);
  }).catch(error => console.warn(`[feishu-reaction] ${summary.messageId}: ${error?.message || error}`))
    .finally(() => jobs.delete(key));
  jobs.set(key, job);
}

async function addProcessingReaction(runtime, summary, emojiType = 'THINKING', { track = true } = {}) {
  if (isFeishuDocumentCommentSummary(summary)) {
    return withTimeout(() => addFeishuCommentProcessingReaction(runtime, summary),
      DEFAULT_PROCESSING_REACTION_TIMEOUT_MS, 'Feishu comment processing reaction');
  }
  const messageId = trimString(summary?.messageId);
  const createReaction = runtime?.appClient?.im?.v1?.messageReaction?.create;
  if (!messageId || typeof createReaction !== 'function') {
    return null;
  }
  if (track && emojiType === 'THINKING' && runtime.config?.storageDir) {
    const store = runtime.readReactionStore ||= createFeishuReadReactionStore(runtime.config.storageDir);
    const receipt = await store.add(messageId, () => addProcessingReaction(runtime, summary, emojiType, { track: false }), {
      chatId: summary.chatId, tenantKey: summary.tenantKey || summary.sender?.tenantKey || '',
      topicId: buildFeishuTopicId(summary),
    });
    if (participationEnabled(runtime, summary)) {
      const state = await participationController(runtime).state(summary);
      if (!participationAllowsMessage(state, summary) || (summary.participationEpoch !== undefined
          && Number(summary.participationEpoch) !== state.epoch)) {
        await store.remove(messageId, (id, reactionId) => removeProcessingReaction(runtime, id, reactionId));
        return null;
      }
    }
    return receipt;
  }
  const response = await withTimeout(
    () => createReaction.call(runtime.appClient.im.v1.messageReaction, {
      path: {
        message_id: messageId,
      },
      data: {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
    }),
    DEFAULT_PROCESSING_REACTION_TIMEOUT_MS,
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

function createQuickParticipationReaction(runtime) {
  return (summary, emojiType) => addProcessingReaction(runtime, summary, emojiType);
}

async function removeProcessingReaction(runtime, messageId, reactionId) {
  const response = await runtime.appClient.im.v1.messageReaction.delete({
    path: { message_id: messageId, reaction_id: reactionId },
  });
  if (response.code !== undefined && response.code !== 0) {
    const error = new Error(response.msg || 'Failed to remove Feishu processing reaction');
    error.code = response.code;
    throw error;
  }
}


async function sendFeishuText(runtime, summary, text, uuid = '', mentions = summary?.mentions) {
  if (isFeishuDocumentCommentSummary(summary)) {
    return sendFeishuCommentReply(runtime, summary, text);
  }
  // Decide before the legacy post normalizer can clip the source. Keep this
  // one durable delivery and one visible send: upload is preparation, and the
  // existing receipt/lease/error path still owns retries and restart recovery.
  const fullText = summary.deliveryNotice ? text : cleanFeishuReplyText(text);
  const sendFullReplyFile = () => sendFeishuAttachment(runtime, summary, {
    originalName: '完整答复.md',
    mimeType: 'text/markdown; charset=utf-8',
    buffer: Buffer.from(fullText, 'utf8'),
  }, uuid);
  if (!summary.deliveryNotice && fullText.length > MAX_FEISHU_TEXT_LENGTH) {
    return sendFullReplyFile();
  }
  const content = summary.deliveryNotice ? JSON.stringify({ text }) : await buildFeishuPostContent(text, mentions, {
    resolveFormulaImage: (formula) => resolveFeishuFormulaImage(runtime, formula),
    onFormulaError: (error, formula) => {
      console.warn(
        `[feishu-connector] ${formula?.display ? 'display' : 'inline'} formula fallback: ${error?.message || error}`,
      );
    },
  });
  let cardContent = null;
  if (!summary.deliveryNotice) {
    try { cardContent = await buildFeishuTableCard(content, { foldedDetails: summary.foldedDetails }); }
    catch (error) { console.warn(`[feishu-connector] table card conversion fallback: ${error.message}`); }
  }
  // A folded detail contract must never fall back to a flat wall of text.
  // Preserve the complete reply as one file when the card cannot represent it.
  if (summary.foldedDetails && !cardContent) return sendFullReplyFile();
  // Markup/JSON expansion can exceed the payload budget even for short text.
  // Check both candidates so an explicit card rejection can safely use post.
  if (!summary.deliveryNotice && [content, cardContent].filter(Boolean).some(payload =>
    Buffer.byteLength(JSON.stringify({ msg_type: 'interactive', content: payload }), 'utf8') > 28_000)) {
    return sendFullReplyFile();
  }
  const replyUuid = buildFeishuApiUuid(uuid, summary);
  const reply = shouldReplyToFeishuMessage(summary);
  const send = (msgType, payload) => reply
    ? runtime.appClient.im.v1.message.reply({
      path: {
        message_id: summary.messageId,
      },
      data: {
        msg_type: msgType,
        content: payload,
        reply_in_thread: shouldReplyInFeishuThread(summary),
        uuid: replyUuid,
      },
    })
    : runtime.appClient.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: summary.chatId,
      msg_type: msgType,
      content: payload,
      uuid: replyUuid,
    },
  });
  let response;
  try {
    response = await send(cardContent ? 'interactive' : summary.deliveryNotice ? 'text' : 'post', cardContent || content);
  } catch (error) {
    const rejection = error?.response?.data || error;
    if (!cardContent || Number(rejection?.code) !== 230099 || rejection?.data?.message_id) throw error;
    response = rejection;
  }
  // Only an explicit card-construction rejection proves no message was sent.
  // Timeouts, rate limits and ambiguous failures retain the durable retry path.
  if (cardContent && Number(response.code) === 230099 && !response.data?.message_id) {
    if (summary.foldedDetails) return sendFullReplyFile();
    console.warn('[feishu-connector] card rejected; delivering original rich-text post');
    response = await send('post', content);
  }
  if ((response.code !== undefined && response.code !== 0) || !response.data?.message_id) {
    throw feishuResponseError(response, reply ? 'Failed to send Feishu topic reply' : 'Failed to send Feishu reply');
  }
  return response.data;
}

async function sendFeishuAttachment(runtime, summary, attachment, uuid = '') {
  return sendFeishuAttachmentImpl(runtime, summary, attachment, uuid, { ensureAuthCookie });
}

async function processSourceDeliveryOnce(runtime, helpers = {}) {
  const request = helpers.requestRemoteLab || ((path, options) => requestRemoteLab(runtime, path, options));
  const receipts = runtime.deliveryReceipts ||= createDeliveryReceipts(join(runtime.config.storageDir, 'delivery-receipts'));
  const failures = runtime.deliveryFailures ||= createDeliveryReceipts(join(runtime.config.storageDir, 'delivery-failures'));
  const readReactionStore = runtime.readReactionStore ||=
    createFeishuReadReactionStore(runtime.config.storageDir);
  const outcomeReactionStore = runtime.outcomeReactionStore ||=
    createFeishuOutcomeReactionStore(runtime.config.storageDir);
  const replayOptions = {
    continueOnError: true, limit: 10, budgetMs: 30_000,
    onError: (error, receipt) => console.error(`[feishu-connector] delivery acknowledgement deferred (${receipt.deliveryId}): ${error.message}`),
    ...helpers.receiptReplayOptions,
  };
  const acknowledgeFailure = async receipt => {
    const result = await request(`/api/source-deliveries/${receipt.deliveryId}/fail`, { method: 'POST', body: {
      leaseId: receipt.leaseId, ...receipt.failure,
    } });
    if (!result.response.ok) throw new Error(result.json?.error || 'Failed to record delivery failure');
    return result.json.delivery;
  };
  const acknowledge = async receipt => {
    if (receipt.kind === 'reaction' && !receipt.processingState) {
      await outcomeReactionStore.clean(receipt.target?.messageId,
        (messageId, reactionId) => (helpers.removeProcessingReaction || removeProcessingReaction)(
          runtime, messageId, reactionId));
      if (['p2p', 'private'].includes(receipt.target?.chatType)) await readReactionStore.remove(receipt.target?.messageId,
        (messageId, reactionId) => (helpers.removeProcessingReaction || removeProcessingReaction)(
          runtime, messageId, reactionId));
    }
    await recordFeishuBotHandoffScope(runtime, receipt.target, {
      sessionId: receipt.sessionId, threadId: receipt.threadId, messageId: receipt.messageId,
    });
    if (receipt.sessionId && receipt.messageId && runtime.storagePaths?.messageIndexPath) {
      const outboundTarget = receipt.threadId && receipt.target?.conversationKind !== 'main'
        ? { ...receipt.target, threadId: receipt.threadId }
        : receipt.target;
      await recordFeishuOutboundMessageSession(runtime, outboundTarget, receipt.sessionId, receipt.messageId);
      if (receipt.target?.conversationKind !== 'main' && receipt.target?.sourceKind !== 'ambient_thread_open') {
        await recordFeishuThreadSessionBinding(runtime, receipt.target, receipt.sessionId, { threadId: receipt.threadId });
      }
    }
    await appendLinkedFeishuProjectDelivery(runtime, receipt);
    const completed = await request(`/api/source-deliveries/${receipt.deliveryId}/complete`, { method: 'POST', body: {
      leaseId: receipt.leaseId, externalId: receipt.externalId, messageId: receipt.messageId, threadId: receipt.threadId,
    } });
    if (!completed.response.ok) throw new Error(completed.json?.error || 'Failed to record delivery receipt');
    return completed.json.delivery;
  };
  await receipts.flush(receipt => withFeishuHandoffLock(runtime, receipt.target, () => acknowledge(receipt)), replayOptions);
  await failures.flush(acknowledgeFailure, replayOptions);
  const { response, json } = await request('/api/source-deliveries/claim', { method: 'POST', body: {
    connector: FEISHU_CONNECTOR_ID, sourceRouteId: runtime.config.sourceRouteId || 'default',
    waitMs: Math.max(0, Number.parseInt(helpers.waitMs, 10) || 0),
  }, signal: helpers.signal });
  if (!response.ok) throw new Error(json?.error || 'Failed to claim delivery');
  const claim = json?.claim;
  if (!claim) return null;
  const delivery = claim.delivery;
  const summary = await (helpers.enrichSummaryWithChatMetadata || resolveFeishuGroupSource)(runtime, {
    chatType: 'group', ...delivery.target, mentions: [], deliveryNotice: delivery.kind === 'delivery_notice',
    ...(delivery.foldedDetails ? { foldedDetails: delivery.foldedDetails } : {}) });
  return withFeishuHandoffLock(runtime, summary, async () => {
    if (delivery.processingState !== 'finished' && participationEnabled(runtime, summary)) {
      const controller = participationController(runtime, helpers);
      const status = await controller.state(summary);
      const scopeId = summary.participationScopeTopicId;
      const originSummary = scopeId ? { ...summary,
        conversationKind: scopeId === 'main' ? 'main' : 'thread',
        groupMessageType: scopeId === 'main' ? 'group' : 'thread',
        chatMode: scopeId === 'main' ? 'group' : 'thread',
        topicId: scopeId === 'main' ? '' : scopeId, threadId: scopeId === 'main' ? '' : scopeId,
        rootId: scopeId === 'main' ? '' : scopeId,
        messageId: summary.participationScopeMessageId,
      } : summary;
      const originStatus = scopeId ? await controller.state(originSummary) : status;
      const epoch = Number(summary.participationEpoch);
      const stale = summary.participationEpoch !== undefined
        && (!Number.isSafeInteger(epoch) || epoch < (originStatus.deliveryEpochFloor ?? originStatus.epoch)
          || epoch > originStatus.epoch);
      const originBlocked = scopeId && originStatus.mode !== 'active'
        && !originStatus.invitedMessages?.includes(originSummary.messageId);
      if (stale || originBlocked || (status.mode !== 'active' && !status.invitedMessages?.includes(summary.messageId))) {
        const resolved = await request(`/api/source-deliveries/${delivery.id}/resolve`, { method: 'POST',
          body: { state: 'cancelled', leaseId: claim.leaseId, reason: `Group participation is ${status.mode}; stale=${stale}` } });
        if (!resolved.response.ok) throw new Error(resolved.json?.error || 'Unable to cancel paused group delivery');
        await readReactionStore.remove(summary.messageId,
          (messageId, reactionId) => (helpers.removeProcessingReaction || removeProcessingReaction)(runtime, messageId, reactionId));
        return resolved.json?.delivery;
      }
    }
    let sent;
    try {
      // Recheck current policy so an old queued start cannot recreate the
      // indicator after the group has disabled it. Finished cleanup still runs.
      if (delivery.processingState === 'active' && !resolveFeishuGroupSettings(runtime.config, summary).processingReactions) {
        await readReactionStore.remove(summary.messageId,
          (messageId, reactionId) => (helpers.removeProcessingReaction || removeProcessingReaction)(runtime, messageId, reactionId));
        const resolved = await request(`/api/source-deliveries/${delivery.id}/resolve`, { method: 'POST',
          body: { state: 'cancelled', leaseId: claim.leaseId, reason: 'Processing reactions are disabled for this group' } });
        if (!resolved.response.ok) throw new Error(resolved.json?.error || 'Unable to cancel disabled processing reaction');
        return resolved.json?.delivery;
      }
      if (delivery.kind === 'reaction' && !delivery.processingState && delivery.emojiType !== null
          && !resolveFeishuGroupSettings(runtime.config, summary).reactionCandidates.includes(delivery.emojiType)) {
        const resolved = await request(`/api/source-deliveries/${delivery.id}/resolve`, { method: 'POST',
          body: { state: 'cancelled', leaseId: claim.leaseId, reason: 'Reaction is outside the current group selection' } });
        if (!resolved.response.ok) throw new Error(resolved.json?.error || 'Unable to cancel unselected reaction');
        return resolved.json?.delivery;
      }
      sent = delivery.processingState === 'finished'
        ? (await readReactionStore.remove(summary.messageId,
          (messageId, reactionId) => (helpers.removeProcessingReaction || removeProcessingReaction)(runtime, messageId, reactionId)), { withdrawn: true })
        : delivery.processingState === 'active'
        ? await (helpers.addProcessingReaction || addProcessingReaction)(runtime, summary)
        : delivery.memoryReview
        ? await sendMemoryReviewCard(runtime, delivery)
        : delivery.automationControl
        ? await sendAutomationCard(runtime, delivery, { request })
        : delivery.nativeQuestion
        ? await sendNativeQuestionCard(runtime, delivery)
        : delivery.kind === 'reaction'
        ? await outcomeReactionStore.apply(summary.messageId, delivery.emojiType,
          () => (helpers.addProcessingReaction || addProcessingReaction)(runtime, summary, delivery.emojiType),
          { stage: delivery.reactionStage || 1 })
        : delivery.attachment
          ? await (helpers.sendFeishuAttachment || sendFeishuAttachment)(runtime, summary, delivery.attachment, delivery.id)
          : await (helpers.sendFeishuText || sendFeishuText)(runtime, summary, delivery.text, delivery.id);
      if (delivery.kind === 'reaction' && !sent?.reactionId && !sent?.withdrawn && !sent?.superseded) {
        throw new Error('Feishu reaction did not return a receipt');
      }
    } catch (error) {
      // Persist rejection evidence before acknowledging it, just like success
      // receipts. Restart must not turn a known rejection into an unknown send.
      await failures.record({ deliveryId: delivery.id, leaseId: claim.leaseId,
        failure: classifyFeishuDeliveryError(error) });
      await failures.flush(acknowledgeFailure, replayOptions);
      throw error;
    }
    if (sent?.superseded) {
      const resolved = await request(`/api/source-deliveries/${delivery.id}/resolve`, { method: 'POST',
        body: { state: 'cancelled', leaseId: claim.leaseId, reason: 'A later routing reaction already owns this source message' } });
      if (!resolved.response.ok) throw new Error(resolved.json?.error || 'Unable to suppress an older reaction');
      return resolved.json?.delivery;
    }
    if (sent?.skipped) {
      const resolved = await request(`/api/source-deliveries/${delivery.id}/resolve`, { method: 'POST',
        body: { state: 'cancelled', leaseId: claim.leaseId, reason: delivery.automationControl
          ? 'Automation stopped before its entry card; suppressed late notification'
          : 'Question already ended without an original card; suppressed late notification' } });
      if (!resolved.response.ok) throw new Error(resolved.json?.error || 'Unable to suppress stale question delivery');
      return resolved.json?.delivery;
    }
    if (delivery.kind !== 'reaction') {
      runtime.quickParticipation?.rememberBotReply(summary, sent.message_id, delivery.text,
        summary.conversationKind === 'main' ? '' : sent.thread_id);
    }
    await receipts.record({ deliveryId: delivery.id, leaseId: claim.leaseId,
      externalId: sent.message_id || sent.reply_id || sent.reactionId || '', messageId: sent.message_id || '',
      threadId: sent.thread_id || '', sessionId: delivery.sessionId, target: summary,
      kind: delivery.kind, ...(delivery.processingState ? { processingState: delivery.processingState } : {}),
      ...(delivery.kind === 'content' ? { text: delivery.text } : {}) });
    let completed;
    await receipts.flush(async receipt => { completed = await acknowledge(receipt); }, replayOptions);
    return completed;
  });
}

function startSourceDeliveryPoller(runtime, options = {}) {
  if (runtime.sourceDeliveryPollPromise) return runtime.sourceDeliveryPollPromise;
  const waitMs = Math.min(25_000, Math.max(1000,
    Number.parseInt(options.waitMs, 10) || DEFAULT_SOURCE_DELIVERY_LONG_POLL_MS));
  const retryMs = Math.max(250,
    Number.parseInt(options.retryMs, 10) || DEFAULT_SOURCE_DELIVERY_RETRY_MS);
  const processOnce = options.processOnce || processSourceDeliveryOnce;
  runtime.sourceDeliveryPollStopped = false;
  runtime.sourceDeliveryPollAbort = new AbortController();
  const signal = runtime.sourceDeliveryPollAbort.signal;
  const pollPromise = (async () => {
    while (!runtime.sourceDeliveryPollStopped) {
      try {
        void runtime.cardReadSampler?.tick();
        await processOnce(runtime, { waitMs, signal });
      } catch (error) {
        if (runtime.sourceDeliveryPollStopped || signal.aborted) break;
        console.error(`[feishu-connector] source delivery wait failed: ${error?.message || error}`);
        try {
          await delay(retryMs, undefined, { signal });
        } catch (delayError) {
          if (!signal.aborted) throw delayError;
        }
      }
    }
  })();
  runtime.sourceDeliveryPollPromise = pollPromise.finally(() => {
    runtime.sourceDeliveryPollPromise = null;
    runtime.sourceDeliveryPollAbort = null;
  });
  return runtime.sourceDeliveryPollPromise;
}

function stopSourceDeliveryPoller(runtime) {
  if (!runtime?.sourceDeliveryPollPromise) return false;
  runtime.sourceDeliveryPollStopped = true;
  runtime.sourceDeliveryPollAbort?.abort();
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
  if (senderType && senderType !== 'user' && (
    isFeishuDocumentCommentSummary(summary) || !isFeishuBotSender(summary)
  )) return false;
  return true;
}

function stripMentionTokens(text) {
  return String(text || '').replace(/@_[A-Za-z0-9_]+/g, ' ');
}

function stripLeadingMentionTokens(text) {
  return String(text || '').replace(/^\s*(?:@_[A-Za-z0-9_]+\s*)+/, '');
}

function extractLocalCommand(summary) {
  const chatType = trimString(summary?.chatType).toLowerCase();
  if (!['group', 'topic', 'p2p', 'private'].includes(chatType)) return null;
  const rawText = summary?.messageText || summary?.textPreview || summary?.rawContent;
  const commandText = stripLeadingMentionTokens(rawText);
  const privateChat = ['p2p', 'private'].includes(summary.chatType);
  const normalized = privateChat && ['开启新对话', '新对话', 'New conversation'].includes(commandText.trim()) ? '/new'
    : privateChat && ['我的设置', '个人设置', '使用说明', 'My settings', 'How to use'].includes(commandText.trim()) ? '/settings' : commandText;
  const parsed = parseFeishuCommandBlock(normalized);
  if (parsed.error) return parsed;
  return parsed.commands.length > 0 ? parsed : null;
}

async function queueFeishuReply(runtime, summary, text, { responseId = buildRequestId(summary) } = {}) {
  const result = await requestRemoteLab(runtime, '/api/source-deliveries', { method: 'POST', body: {
    responseId, text,
    sourceDelivery: { connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId || 'default', target: summary },
  } });
  if (!result.response.ok) throw new Error(result.json?.error || 'Failed to enqueue reply');
  return { message_id: '', deliveryId: result.json.delivery.id };
}

async function submitFeishuFeedback(runtime, summary, kind, sessionId = '') {
  const requester = (path, options = {}) => requestRemoteLab(runtime, path, options);
  let targetSessionId = trimString(sessionId);
  if (targetSessionId) {
    const existing = await requester(`/api/sessions/${encodeURIComponent(targetSessionId)}`);
    if (existing.response.status === 404) return { ignored: true, reason: 'feedback_session_deleted' };
    if (!existing.response.ok) throw new Error(existing.json?.error || 'Unable to read feedback Session');
  }
  if (!targetSessionId) {
    const routed = buildFeishuTopicId(summary)
      ? applyFeishuReplyRouting(runtime.config, summary)
      : { ...summary, conversationKind: 'main', replyInThread: false, startThread: false };
    const conversation = {
      connector: FEISHU_CONNECTOR_ID,
      sourceRouteId: runtime.config.sourceRouteId || 'default',
      target: buildFeishuSessionConversationTarget(routed),
    };
    const resolved = await requester('/api/session-conversations/resolve', {
      method: 'POST', body: { conversation },
    });
    if (!resolved.response.ok) throw new Error(resolved.json?.error || 'Unable to resolve feedback Session');
    targetSessionId = trimString(resolved.json?.sessionId);
  }
  if (!targetSessionId) return { ignored: true, reason: 'no_existing_session' };
  const text = kind === 'mute_reaction'
    ? '【群聊反馈】用户在你发出的消息上添加了 [嘘]，当前讨论已静默。请复盘上次介入是否过早或打断讨论，供之后判断使用。本轮不要回复，也不要执行任务。'
    : kind === 'mute_command'
      ? '【群聊反馈】用户单独要求静默当前讨论。请复盘刚才的回复是否不合时宜，供之后判断使用。本轮不要回复，也不要执行任务。'
      : kind === 'reaction_feedback'
        ? `【群聊表情反馈】用户在你发出的消息上添加了 ${summary.reactionType}。这是针对该条回复的反馈线索，不代表事实正确、任务完成或长期行为指令。结合原消息理解并留作后续判断。本轮不要回复，也不要执行任务。`
        : '【群聊反馈】用户恢复了当前讨论的自动响应。本轮只记录这一变化，不要回复，也不要执行任务。';
  return submitConnectorMessage(requester, targetSessionId, {
    requestId: `feishu:feedback:${kind}:${trimString(summary.eventId || summary.messageId)}`,
    text,
    sourceContext: {
      ...buildMessageSourceContext(summary),
      feishuParticipation: 'feedback',
      feishuFeedback: kind,
    },
  });
}

function participationController(runtime, helpers = {}) {
  if (runtime.participation) return runtime.participation;
  const request = helpers.requestRemoteLab || ((path, options) => requestRemoteLab(runtime, path, options));
  runtime.participation = createParticipationController(runtime, {
    resolveSource: summary => (helpers.enrichSummaryWithChatMetadata || resolveFeishuGroupSource)(runtime, {
      ...summary, chatType: summary.chatType || 'group',
    }),
    ...(runtime.groupConfiguration ? { getConfiguration: record => runtime.groupConfiguration.view(record) } : {}),
    authorize: summary => isAllowedByPolicy(runtime.config.accessPolicy, summary),
    resolveSession: async summary => {
      const binding = await findFeishuThreadSessionBinding(runtime, summary);
      if (binding?.sessionId) return binding.sessionId;
      const routed = applyFeishuReplyRouting(runtime.config, summary);
      const result = await request('/api/session-conversations/resolve', { method: 'POST', body: {
        conversation: { connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId || 'default',
          target: buildFeishuSessionConversationTarget(routed) },
      } });
      if (!result.response.ok) throw new Error(result.json?.error || 'Unable to resolve participation Session');
      return result.json?.sessionId || '';
    },
    cancelSession: async (sessionId, record) => {
      if (record) {
        const source = record.source;
        const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST', body: {
          participationConversation: { connector: 'feishu', sourceRouteId: source.sourceRouteId,
            target: { chatId: source.chatId, tenantKey: source.tenantKey,
              conversationKind: source.topicId ? 'thread' : 'main',
              ...(source.topicId ? { threadId: source.topicId } : {}) } },
        } });
        if (!result.response.ok && result.response.status !== 404) throw new Error(result.json?.error || 'Unable to stop conversation work');
        return;
      }
    },
    cleanup: async record => {
      const store = runtime.readReactionStore ||= createFeishuReadReactionStore(runtime.config.storageDir);
      for (const reaction of await store.active()) {
        const source = reaction.source || (runtime.storagePaths?.messageIndexPath
          ? await findConnectorMessageIndexRecord(runtime.storagePaths.messageIndexPath, {
            connector: FEISHU_CONNECTOR_ID, accountId: record.source.tenantKey, messageId: reaction.messageId,
          }) : null);
        const topic = source?.topicId || source?.threadId
          || (source?.conversationKind === 'thread' ? source.conversationId : '') || '';
        if (source?.chatId !== record.source.chatId || topic !== record.source.topicId
            || ((source.tenantKey || source.accountId) && (source.tenantKey || source.accountId) !== record.source.tenantKey)) continue;
        await store.remove(reaction.messageId,
          (messageId, reactionId) => (helpers.removeProcessingReaction || removeProcessingReaction)(runtime, messageId, reactionId));
      }
    },
  });
  return runtime.participation;
}

function groupConfigurationController(runtime, helpers = {}) {
  if (runtime.groupConfiguration) return runtime.groupConfiguration;
  runtime.groupConfiguration = createGroupConfigurationController(runtime, {
    request: helpers.requestRemoteLab || ((path, options) => requestRemoteLab(runtime, path, options)),
    resolveDefault: () => resolveFeishuRuntimeSelection(runtime, { chatType: 'group', conversationKind: 'main' }),
    participation: () => participationController(runtime, helpers),
    authorize: summary => isAllowedByPolicy(runtime.config.accessPolicy, summary),
  });
  return runtime.groupConfiguration;
}

async function onboardFeishuGroup(runtime, summary, helpers = {}) {
  summary = await (helpers.enrichSummaryWithChatMetadata || resolveFeishuGroupSource)(runtime, summary);
  if (isFeishuTopicGroup(summary)) return { ignored: true, reason: 'native_topic_group' };
  if (!helpers.projectCard && !participationEnabled(runtime, summary)) return { ignored: true, reason: 'explicit_group_policy' };
  const requester = helpers.requestRemoteLab || ((path, options) => requestRemoteLab(runtime, path, options));
  const existing = await findFeishuSessionBinding({ ...runtime, requestRemoteLab: requester }, {
    ...summary, conversationKind: 'main',
  });
  if (existing?.sessionId) {
    const controller = participationController(runtime, helpers);
    await controller.publish(await controller.remember(summary, existing.sessionId));
    return { onboarded: true, sessionId: existing.sessionId };
  }
  const groupSettings = resolveFeishuGroupSettings(runtime.config, summary);
  const groupFeed = groupSettings.groupFeed === true;
  const groupFeedRollback = groupSettings.groupFeed === false;
  const baseId = buildFeishuSessionExternalTriggerId(summary, runtime.config.sourceRouteId || 'default');
  const folder = groupFeed ? join(homedir(), '.remotelab', 'workspace', 'group-feed',
    runtime.config.sourceRouteId || 'default', summary.chatId) : runtime.config.sessionFolder;
  if (groupFeed) await mkdir(folder, { recursive: true, mode: 0o700 });
  const selection = await (helpers.resolveFeishuRuntimeSelection || resolveFeishuRuntimeSelection)(runtime,
    { ...summary, conversationKind: 'main' });
  const session = await createConnectorSession(requester, {
    folder, tool: selection.tool, model: selection.model || '', effort: selection.effort || '',
    thinking: selection.thinking === true, name: buildSessionName(summary), sourceId: FEISHU_CONNECTOR_ID,
    sourceName: FEISHU_CONNECTOR_NAME, group: FEISHU_CONNECTOR_NAME,
    systemPrompt: groupSettings.systemPrompt,
    conversation: { connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId || 'default',
      target: buildFeishuSessionConversationTarget({ ...summary, conversationKind: 'main' }) },
    externalTriggerId: groupFeed ? baseId.replace('feishu:main:', 'feishu:group-feed:')
      : groupFeedRollback ? baseId.replace('feishu:main:', 'feishu:legacy-return:') : baseId,
    ...(groupFeed ? { groupFeed: true } : {}),
  });
  const controller = participationController(runtime, helpers);
  const record = await controller.remember(summary, session.id);
  await controller.publish(record);
  return { onboarded: true, sessionId: session.id };
}

async function handleFeishuReactionMute(runtime, summary, helpers = {}) {
  if (summary.sourceKind !== 'reaction_mute') return { ignored: true };
  if (summary.sender?.openId === runtime.botIdentity?.openId) return { ignored: true, reason: 'self_reaction' };
  if (participationEnabled(runtime, summary)) {
    await participationController(runtime, helpers).change(summary, 'paused', { sessionId: summary.feedbackSessionId });
    return { mode: 'paused', chatId: summary.chatId, threadId: summary.threadId || '' };
  }
  await setFeishuConversationMuted(runtime, summary, true);
  await (helpers.submitFeishuFeedback || submitFeishuFeedback)(
    runtime, summary, 'mute_reaction', summary.feedbackSessionId);
  return { muted: true, chatId: summary.chatId, threadId: summary.threadId || '' };
}

async function handleFeishuReactionFeedback(runtime, summary, helpers = {}) {
  if (summary.sourceKind === 'reaction_mute') return handleFeishuReactionMute(runtime, summary, helpers);
  if (summary.sourceKind !== 'reaction_feedback') return { ignored: true };
  if (summary.sender?.openId === runtime.botIdentity?.openId) return { ignored: true, reason: 'self_reaction' };
  await (helpers.submitFeishuFeedback || submitFeishuFeedback)(
    runtime, summary, 'reaction_feedback', summary.feedbackSessionId);
  return { recorded: true, chatId: summary.chatId, reactionType: summary.reactionType };
}

async function handleMessage(runtime, summary, sourceLabel, helpers = {}) {
  if (helpers.preparedSubmission) {
    if (helpers.preparedSubmission.mode === 'observe') return { ignored: true, reason: 'listening_retired' };
    // Retry the saved ownership, body and mode. New settings or another
    // runtime-command pass must not rebuild a possibly accepted packet.
    return processFeishuMessage(runtime, helpers.preparedSubmission.summary || summary, null, helpers);
  }
  // Publication can create thread aliases before its HTTP acknowledgement.
  // Fence only routing and bot admission against that publication; reaction,
  // attachment and RemoteLab transport work must not lock every chat topic.
  const admission = await withFeishuHandoffLock(runtime, summary,
    () => prepareFeishuMessage(runtime, summary, helpers));
  if (admission.receipt) return admission.receipt;
  return processFeishuMessage(runtime, admission.summary, admission.command, helpers);
}

async function prepareFeishuMessage(runtime, summary, helpers) {
  if (!isProcessableMessage(summary)) return { receipt: { ignored: true } };
  summary = await (helpers.enrichSummaryWithChatMetadata || enrichSummaryWithChatMetadata)(runtime, summary);
  summary = await resolveFeishuReferencedTopic(runtime, summary);
  if (participationEnabled(runtime, summary)) {
    const controller = participationController(runtime, helpers);
    const intakeState = await controller.state(summary);
    const arrival = helpers.participationSnapshot;
    // Chat metadata can reveal a topic absent from the raw event. An arrival
    // snapshot from the mainline must never control that independent topic.
    const snapshot = !arrival?.key || arrival.key === intakeState.key ? arrival : null;
    const control = await controller.intake(summary, snapshot);
    if (control) return { receipt: control };
    summary = { ...summary, participationEpoch: String(snapshot?.epoch ?? intakeState.epoch) };
  }
  const command = extractLocalCommand(summary);
  const commandNames = command?.commands?.map(entry => entry.name) || [];
  if (command && !command.error && !commandNames.some(name => ['inline', 'thread', 'quick', 'sota', 'claude'].includes(name))
    && /^\s*@_[A-Za-z0-9_]+/.test(summary.messageText || summary.textPreview || summary.rawContent || '')
    && !mentionsFeishuBot(runtime, summary)) {
    return { receipt: { ignored: true, reason: 'command_for_other_recipient' } };
  }
  if (!isFeishuDocumentCommentSummary(summary) && !await shouldRouteFeishuMessageToRemoteLab(runtime, summary, { explicitCommand: !!command })) {
    console.log(`[feishu-connector] skipped ${summary.messageId} (response policy or conversation mute)`);
    return { receipt: { ignored: true, reason: 'group_reply_policy' } };
  }
  if (isFeishuDocumentCommentSummary(summary)) summary = await (helpers.hydrateSummary || hydrateFeishuDocumentCommentSummary)(runtime, summary);
  if (command && command.error) return { summary, command };
  if (command?.body && !commandNames.some(name => ['inline', 'thread', 'quick', 'sota', 'claude'].includes(name))) summary = {
    ...summary, messageText: command.body, textPreview: command.body,
  };
  if (command && !commandNames.some(name => ['inline', 'thread', 'quick', 'sota', 'claude'].includes(name))) {
    if (isFeishuBotSender(summary)) return { receipt: { ignored: true, reason: 'bot_control_command' } };
    return { summary, command };
  }
  if (commandNames.includes('inline') && buildFeishuTopicId(summary)) {
    if (isFeishuBotSender(summary)) return { receipt: { ignored: true, reason: 'bot_control_command' } };
    const error = isFeishuTopicChat(summary)
      ? '话题群只支持 Thread；请使用 /thread，或直接发送任务正文。'
      : 'Thread 内不能切换为 inline；请直接发送任务正文。';
    return { summary, command: { ...command, error } };
  }
  if (commandNames.includes('inline')) summary = {
    ...summary, replyModeOverride: 'inline', messageText: command.body, textPreview: command.body,
  };
  if (commandNames.includes('thread')) summary = {
    ...summary, replyModeOverride: 'thread', messageText: command.body, textPreview: command.body,
  };
  if (commandNames.includes('quick') || commandNames.includes('sota') || commandNames.includes('claude')) summary = {
    ...summary, ...(commandNames.includes('quick') ? { quickMode: true } : {}),
    messageText: command.body, textPreview: command.body,
  };
  if (command?.body && !commandNames.includes('inline') && !commandNames.includes('thread') && !commandNames.includes('quick') && !commandNames.includes('sota') && !commandNames.includes('claude')) summary = {
    ...summary, messageText: command.body, textPreview: command.body,
  };
  summary = applyFeishuReplyRouting(runtime.config, { ...summary, commandBlock: command });
  if (isFeishuBotSender(summary) && runtime.config.botHandoffPolicy !== 'unlimited') {
    const binding = await findFeishuThreadSessionBinding(runtime, summary);
    if (!await claimFeishuBotHandoff(runtime, summary, binding?.sessionId)) {
      return { receipt: { ignored: true, reason: 'bot_handoff_consumed' } };
    }
    summary = { ...summary, botHandoffMessageId: summary.messageId };
  }
  return { summary, command };
}

async function processFeishuMessage(runtime, summary, command, helpers) {
  const groupSettings = resolveFeishuGroupSettings(runtime.config, summary);
  const projectCommand = command?.commands?.find(entry => entry.name === 'project');
  if (projectCommand) {
    const enqueue = helpers.queueFeishuReply || queueFeishuReply;
    if (command.commands.length !== 1) return enqueue(runtime, summary, '/project 请单独使用。');
    if (!runtime.projectSurface && runtime.config.projectSurfacesPath) runtime.projectSurface = createProjectSurface(runtime, {
      request: helpers.requestRemoteLab || runtime.requestRemoteLab,
      authorize: summary => isAllowedByPolicy(runtime.config.accessPolicy, summary),
    });
    if (!runtime.projectSurface) return enqueue(runtime, summary, '当前群尚未启用项目入口。');
    let result;
    try { result = await runtime.projectSurface.command(summary, projectCommand.value); }
    catch (error) { return enqueue(runtime, summary, /^[\u3400-\u9fff]/.test(error.message)
      ? error.message : '项目入口来源暂时不可核实，请刷新后重试。'); }
    if (result.text) return enqueue(runtime, summary, result.text);
    if (!result.taskText) return result;
    summary = { ...summary, messageText: result.taskText, textPreview: result.taskText };
    command = null;
  }
  if (command?.error) return (helpers.queueFeishuReply || queueFeishuReply)(runtime, summary, command.error);
  const commandNames = command?.commands?.map(entry => entry.name) || [];
  const taskCommand = commandNames.some(name => ['inline', 'thread', 'quick', 'sota', 'claude'].includes(name));
  const enqueue = helpers.queueFeishuReply || queueFeishuReply;
  if (commandNames.includes('settings')) {
    if (commandNames.length !== 1 || command.body) return enqueue(runtime, summary, '请单独发送 /settings 或“我的设置”。');
    if (!runtime.personalSettings?.enabled(summary)) return enqueue(runtime, summary, '个人设置请在已开放的机器人私聊中打开。');
    try { return await runtime.personalSettings.publish(summary, { renew: true, view: ['使用说明', 'How to use'].includes(stripLeadingMentionTokens(summary.messageText || summary.textPreview || summary.rawContent).trim()) ? 'help' : 'settings', requestId: summary.messageId }); }
    catch (error) { return enqueue(runtime, summary, error.message); }
  }
  if (commandNames.includes('log')) {
    if (commandNames.length !== 1) return enqueue(runtime, summary, '/log 请单独使用。');
    const target = await prepareFeishuLogContinuation(command.commands[0].value, {
      request: helpers.requestRemoteLab || ((path, options) => requestRemoteLab(runtime, path, options)),
      runtime,
      summary,
    });
    if (target.error) return enqueue(runtime, summary, target.error);
    summary = {
      ...summary,
      messageText: target.question,
      textPreview: target.question,
      logContinuation: { sessionId: target.sessionId, runId: target.runId },
      ...(isFeishuThreadConversation(summary) ? {} : { replyModeOverride: 'inline' }),
    };
    command = null;
  }
  if (command?.body && commandNames.some(name => ['help', 'status', 'mute', 'unmute', 'progress'].includes(name))) {
    return enqueue(runtime, summary, '查询和静默命令不能带任务正文；请拆成单独消息。');
  }
  if (commandNames.includes('new') && (commandNames.length !== 1 || command.body)) {
    return enqueue(runtime, summary, '/new 请单独使用，开启后再发送新问题。');
  }
  if (command && !taskCommand && !command.body) {
    if (commandNames.includes('new')) {
      if (commandNames.length !== 1) return enqueue(runtime, summary, '/new 请单独使用。');
      const result = await startFeishuPrivateConversation(runtime, summary, {
        request: helpers.requestRemoteLab || ((path, options) => requestRemoteLab(runtime, path, options)),
        resolveDefault: () => (helpers.resolveFeishuRuntimeSelection || resolveFeishuRuntimeSelection)(runtime, summary),
        systemPrompt: resolveFeishuGroupSettings(runtime.config, summary).systemPrompt,
      });
      if (result.superseded) return { receipt: { ignored: true, reason: 'new_conversation_superseded' } };
      return (helpers.queueFeishuReply || queueFeishuReply)(runtime, summary, result.text);
    }
    if (commandNames.some(name => ['mute', 'unmute'].includes(name))) {
      if (commandNames.length !== 1) return (helpers.queueFeishuReply || queueFeishuReply)(runtime, summary, '静默命令不能和其他命令同时使用。');
      const muteCommand = command.commands[0];
      const text = await handleFeishuMuteCommand(runtime, summary, { type: muteCommand.name, text: muteCommand.value });
      const receipt = await (helpers.queueFeishuReply || queueFeishuReply)(runtime, summary, text);
      await (helpers.submitFeishuFeedback || submitFeishuFeedback)(
        runtime, summary, muteCommand.name === 'mute' ? 'mute_command' : 'unmute_command');
      return receipt;
    }
    const text = await handleFeishuRuntimeCommands(runtime, summary, command.commands, {
      request: helpers.requestRemoteLab || ((path, options) => requestRemoteLab(runtime, path, options)),
      resolveDefault: () => (helpers.resolveFeishuRuntimeSelection || resolveFeishuRuntimeSelection)(runtime, summary),
      prepared: helpers.preparedRuntimeCommand,
      savePlan: helpers.saveRuntimeCommand,
    });
    if (runtime.groupConfiguration && !buildFeishuTopicId(summary) && participationEnabled(runtime, summary)) {
      const controller = participationController(runtime, helpers);
      void controller.state(summary).then(record => controller.publish(record))
        .catch(error => console.warn(`[feishu-group-configuration] card refresh failed: ${error.message}`));
    }
    return (helpers.queueFeishuReply || queueFeishuReply)(runtime, summary, text);
  }
  if (command && taskCommand && !command.body) return enqueue(runtime, summary, '任务命令需要正文，例如：/thread 帮我调查这个问题。');
  if (command && command.body && command.commands.some(entry => ['harness', 'model', 'effort', 'tier', 'sota', 'claude'].includes(entry.name))) {
    const commandPlan = helpers.preparedRuntimeCommand || await prepareFeishuRuntimeCommandPlan(runtime, summary, command.commands, {
      request: helpers.requestRemoteLab || ((path, options) => requestRemoteLab(runtime, path, options)),
      resolveDefault: () => (helpers.resolveFeishuRuntimeSelection || resolveFeishuRuntimeSelection)(runtime, summary),
      taskMode: true,
    });
    if (commandPlan.error) return enqueue(runtime, summary, commandPlan.text);
    if (!helpers.preparedRuntimeCommand && helpers.saveRuntimeCommand) await helpers.saveRuntimeCommand(commandPlan);
    await applyFeishuRuntimeCommandPlan(commandPlan, {
      request: helpers.requestRemoteLab || ((path, options) => requestRemoteLab(runtime, path, options)),
    });
    summary = { ...summary, runtimeSelectionOverride: commandPlan.selection };
  }
  const controller = participationEnabled(runtime, summary) ? participationController(runtime, helpers) : null;
  let participation = controller ? await controller.state(summary) : null;
  if (participation && summary.participationEpoch !== undefined
      && Number(summary.participationEpoch) !== participation.epoch && !helpers.preparedSubmission) {
    return { ignored: true, reason: 'participation_changed' };
  }
  if (participation && participation.mode !== 'active' && !helpers.preparedSubmission) {
    await controller.assess(summary, { mentioned: mentionsFeishuBot(runtime, summary), taskCommand });
    participation = await controller.state(summary);
  }
  if (participation && participation.mode !== 'active' && participationAllowsMessage(participation, summary)) {
    summary = { ...summary, participationOnce: true };
  }
  try {
    if (groupSettings.quickReactions && runtime.quickParticipation) {
      runtime.quickParticipation.handle(summary);
    }
    if (['p2p', 'private'].includes(summary.chatType)) void Promise.resolve((helpers.addProcessingReaction || addProcessingReaction)(runtime, summary))
      .catch(error => {
        console.warn(`[feishu-connector] failed to add processing reaction for ${summary.messageId}: ${error?.message || error}`);
      });
  } catch (error) {
    console.warn(`[feishu-connector] failed to add processing reaction for ${summary.messageId}: ${error?.message || error}`);
  }
  let receipt;
  try {
    receipt = await (helpers.submitRemoteLabRequest || submitRemoteLabRequest)(runtime, summary);
  } catch (error) {
    if (error?.code === QUICK_PROFILE_CONFLICT) {
      return enqueue(runtime, summary,
        '当前主线或话题已经绑定 Standard Session，不能原地切换为 Quick；请新开一个话题后使用 /quick。');
    }
    throw error;
  }
  if (receipt?.ignored) {
    await runtime.readReactionStore?.remove(summary.messageId,
      (messageId, reactionId) => (helpers.removeProcessingReaction || removeProcessingReaction)(runtime, messageId, reactionId));
    return receipt;
  }
  if (groupSettings.jevReactions) startJevReaction(runtime, summary, receipt, helpers, controller);
  if (runtime.personalSettings?.enabled(summary)) {
    try { await runtime.personalSettings.publish(summary, { automatic: true }); }
    catch (error) { console.warn(`[feishu-personal-settings] welcome: ${error.message}`); }
  }
  await recordFeishuBotHandoffScope(runtime, summary, { sessionId: receipt.sessionId });
  if (runtime.groupConfiguration && !buildFeishuTopicId(summary) && participationEnabled(runtime, summary)) {
    const controller = participationController(runtime, helpers);
    try {
      const record = await controller.remember(summary, receipt.sessionId, [], { refreshCard: false });
      void controller.publish(record)
        .catch(error => console.warn(`[feishu-group-configuration] card refresh failed: ${error.message}`));
    }
    catch (error) { console.warn(`[feishu-group-configuration] card refresh failed: ${error.message}`); }
  } else if (controller) {
    try { await controller.remember(summary, receipt.sessionId); }
    catch (error) { console.warn(`[feishu-participation] remember: ${error.message}`); }
  }
  if (runtime.storagePaths?.messageIndexPath) {
    await recordFeishuMessageSession(runtime, summary, receipt.sessionId, { externalTriggerId: receipt.externalTriggerId });
    await recordFeishuThreadSessionBinding(runtime, summary, receipt.sessionId, { externalTriggerId: receipt.externalTriggerId });
  }
  return receipt;
}

function buildFeishuInboxKey(summary) {
  return JSON.stringify([
    trimString(summary?.tenantKey || summary?.sender?.tenantKey),
    buildExternalTriggerId(summary),
  ]);
}

async function notifyFeishuAdmissionFailure(runtime, entry) {
  const summary = applyFeishuReplyRouting(runtime.config, entry.summary);
  const bindingFailure = ['FEISHU_OBSERVATION_BINDING_REQUIRED', 'FEISHU_OBSERVATION_SOURCE_MISMATCH']
    .includes(entry.admissionFailureCode);
  const notification = await queueFeishuReply(runtime, summary,
    bindingFailure
      ? '这条消息已保存，但话题与原会话的关联校验失败，尚未交给助手。需要先修复关联；重复发送同样的内容不能解决这个问题。'
      : '这条消息已保存，但交给助手时被系统拒绝，尚未开始处理。失败记录已保留，需要排查后恢复。',
    { responseId: `feishu-ingress-failure:${entry.id}` });
  return { failed: true, permanent: true, error: entry.admissionFailure,
    notificationDeliveryId: notification.deliveryId };
}

function initializeInbox(runtime) {
  return createConnectorInbox(join(runtime.config.storageDir, 'inbox'), {
    conversationKey: entry => buildFeishuInboxKey(entry.summary),
    process: async (entry, update) => {
      const allowed = await recordInboundEvent(runtime, entry.summary, entry.raw, entry.sourceLabel);
      if (!allowed) return { blocked: true };
      // Once admission is definitely rejected, retries only publish the same
      // durable notice. They must not execute the rejected input after a repair.
      if (entry.admissionFailure) return notifyFeishuAdmissionFailure(runtime, entry);
      if (entry.summary.sourceKind === 'personal_chat_entered') return runtime.personalSettings.publish(entry.summary, { automatic: true });
      if (entry.summary.sourceKind === 'bot_added') return onboardFeishuGroup(runtime, entry.summary);
      if (['reaction_mute', 'reaction_feedback'].includes(entry.summary.sourceKind)) {
        return handleFeishuReactionFeedback(runtime, entry.summary);
      }
      try {
        return await handleMessage(runtime, entry.summary, entry.sourceLabel, {
          preparedSubmission: entry.submission,
          participationSnapshot: entry.participationSnapshot,
          preparedRuntimeCommand: entry.runtimeCommand,
          saveRuntimeCommand: runtimeCommand => update({ runtimeCommand }),
          submitRemoteLabRequest: (runtime, summary, options = {}) => submitRemoteLabRequest(runtime, summary, {
            ...options, prepared: entry.submission, saveSubmission: submission => update({ submission }),
          }),
        });
      } catch (error) {
        if (error.retryable !== false || isFeishuBotSender(entry.summary)) throw error;
        const admissionFailure = error.message;
        const admissionFailureCode = error.code || '';
        await update({ admissionFailure, admissionFailureCode, lastError: admissionFailure });
        console.error(`[feishu-inbox] ${entry.id}: ${admissionFailure}`);
        return notifyFeishuAdmissionFailure(runtime, { ...entry, admissionFailure, admissionFailureCode });
      }
    },
    onError: error => console.error(`[feishu-inbox] ${error.message}`),
  });
}

export {
  DEFAULT_SESSION_SYSTEM_PROMPT,
  buildExternalTriggerId,
  buildFeishuInboxKey,
  buildFeishuTopicId,
  buildMessageSourceContext,
  buildRemoteLabMessage,
  buildSessionDescription,
  buildSessionSourceContext,
  claimConnectorPidLock,
  buildFeishuPostContent,
  compileFeishuReplyText,
  createRuntimeContext,
  groupConfigurationController,
  onboardFeishuGroup,
  downloadFeishuMessageResource,
  ensureAuthCookie,
  enrichSummaryWithSenderProfile,
  ensureAllowedSendersFile,
  extractLocalCommand,
  findFeishuThreadSessionBinding, resolveFeishuReferencedTopic,
  addProcessingReaction,
  createQuickParticipationReaction,
  handleFeishuReactionMute,
  submitFeishuFeedback,
  submitRemoteLabRequest,
  handleMessage,
  isAllowedByPolicy,
  initializeInbox,
  initializeFeishuInstanceRuntime,
  loadPersistedAccessState,
  loadConfig,
  normalizeAllowedSenders,
  normalizeReplyText,
  releaseConnectorPidLock,
  reconcileKnownFeishuPeople,
  recordFeishuThreadSessionBinding,
  resolveFeishuMessageAttachments,
  resolveFeishuRuntimeSelection,
  resolveFeishuOutboundFileType,
  loadRemoteLabReplyAttachment,
  sendFeishuAttachment,
  sendFeishuText,
  processSourceDeliveryOnce,
  startSourceDeliveryPoller,
  stopSourceDeliveryPoller,
  summarizeFeishuDocumentCommentEvent,
  hydrateFeishuDocumentCommentSummary,
  sendFeishuCommentReply,
  summarizeEvent,
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
  await loadPersistedAccessState(config.accessPolicy);
  const storagePaths = {
    eventsLogPath: join(config.storageDir, 'events.jsonl'),
    knownSendersPath: join(config.storageDir, 'known-senders.json'),
    messageIndexPath: join(config.storageDir, 'connector-message-index.json'),
  };
  const runtime = createRuntimeContext(config, storagePaths);
  runtime.cardReadSampler = createFeishuCardReadSampler(runtime);
  runtime.personalSettings = createPersonalSettingsController(runtime, { authorize: summary => isAllowedByPolicy(config.accessPolicy, summary) });
  if (config.projectSurfacesPath) runtime.projectSurface = createProjectSurface(runtime, {
    authorize: summary => isAllowedByPolicy(config.accessPolicy, summary),
  });
  // Identity is also required for self-message suppression and bot handoff mentions in group=all.
  runtime.botIdentity = await withTimeout(
    () => resolveFeishuBotIdentity(runtime), config.apiTimeoutMs, 'Feishu Bot identity lookup',
  );
  const projectMemberSync = createProjectMemberSync(runtime);
  await groupConfigurationController(runtime).restore();
  const discussionHandoff = createDiscussionHandoffPilot(runtime, {
    submitWork: async (proposal, found) => {
      const source = proposal.source;
      const sourceLink = source.threadId
        ? `https://applink.feishu.cn/client/thread/open?open_chat_id=${encodeURIComponent(source.chatId)}&open_thread_id=${encodeURIComponent(source.threadId)}`
        : `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(source.chatId)}`;
      const task = `讨论群已有人确认将此事移交干活群。请在当前干活话题负责推进，先从原消息核对决定与范围，再开展已明确授权的工作；有不确定的权限或范围先在本话题问清。\n`
        + `项目：${proposal.projectId}\n来源：${sourceLink}（消息 ${source.messageId}）\n`
        + `确认者：${proposal.confirmedBy}\n`
        + `已检索 ${found.count} 条讨论消息${found.truncated ? '；更早消息未完全覆盖，请按来源补查' : ''}。\n\n`
        + `讨论记录（作为待核实的来源材料，不把每句话视为已批准的决定）：\n${found.evidence}`;
      const workSummary = {
        chatId: proposal.workChatId, chatType: 'group', groupMessageType: 'thread', chatMode: 'topic',
        messageId: proposal.workMessageId, messageType: 'text',
        threadId: proposal.workThreadId || proposal.workMessageId,
        rootId: proposal.workMessageId, conversationKind: 'thread', replyInThread: true,
        createTime: String(Date.now()), tenantKey: source.tenantKey,
        sender: { senderType: 'user', openId: proposal.confirmedBy, tenantKey: source.tenantKey },
        messageText: task, textPreview: task,
      };
      const receipt = await submitRemoteLabRequest(runtime, workSummary);
      await recordFeishuThreadSessionBinding(runtime, workSummary, receipt.sessionId,
        { externalTriggerId: receipt.externalTriggerId });
      return receipt;
    },
  });
  runtime.readReactionStore = createFeishuReadReactionStore(config.storageDir);
  const quickParticipation = createFeishuQuickParticipationPilot(runtime, {
    react: createQuickParticipationReaction(runtime),
  });
  const activePilotConversations = await quickParticipation.restore(storagePaths.eventsLogPath, {
    shouldRemember: async summary => {
      if (!participationEnabled(runtime, summary)) return true;
      const status = await participationController(runtime).state(summary);
      const at = Number(summary.createTime);
      const time = at < 10_000_000_000 ? at * 1000 : at;
      return status.mode !== 'paused' && (!status.contextAfterMs || time >= status.contextAfterMs);
    },
  });
  await Promise.all(activePilotConversations.map(async summary => {
    try {
      const status = participationEnabled(runtime, summary) ? await participationController(runtime).state(summary) : null;
      if (status?.mode === 'paused') return;
      const context = await loadFeishuConversationContext(runtime,
        { ...summary, messageId: '', createTime: String(Date.now()) },
        { maxMessages: 30, maxAgeMs: 2 * 60 * 60 * 1000, maxCharacters: 10_000,
          timeoutMs: 1_800, includeMetadata: true,
          ...(status?.contextAfterMs ? { sinceTimeMs: status.contextAfterMs } : {}) });
      if (context?.messages?.length) quickParticipation.seedConversation(summary, context.messages);
    } catch (error) {
      console.warn(`[feishu-quick-participation] history refresh failed: ${error.message}`);
    }
  }));
  runtime.quickParticipation = quickParticipation;
  await restoreFeishuBotHandoffScopes(runtime);
  const inbox = initializeInbox(runtime);
  const meetingIngest = createFeishuMeetingIngest(runtime, {
    submit: async (summary, options) => {
      const receipt = await submitRemoteLabRequest(runtime, summary, options);
      if (receipt.sessionId) {
        await recordFeishuMessageSession(runtime, summary, receipt.sessionId, { externalTriggerId: receipt.externalTriggerId });
        await recordFeishuThreadSessionBinding(runtime, summary, receipt.sessionId, { externalTriggerId: receipt.externalTriggerId });
      }
      return receipt;
    },
  });
  const meetingObserver = createFeishuMeetingObserver(runtime, { onEnded: meetingIngest.accept });
  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: resolveDomain(config.region),
    loggerLevel: resolveLoggerLevel(config.loggerLevel),
  });

  let closed = false;
  let cardRecovery = null;
  runtime.resolveDocumentRuntime = () => resolveFeishuRuntimeSelection(runtime);
  runtime.handleDocumentMention = summary => handleMessage(runtime, summary, 'drive.notice.comment_add_v1');
  const documentEvents = await startDocumentBindingEvents(runtime);
  let cardsStopped = null;
  const closeConnection = (reason) => {
    if (closed) return;
    closed = true;
    cardsStopped = cardRecovery?.stop();
    stopSourceDeliveryPoller(runtime);
    runtime.projectSurface?.stop();
    void documentEvents.stop();
    inbox.stop();
    meetingObserver.stop();
    meetingIngest.stop();
    projectMemberSync.stop();
    console.log(`[feishu-connector] closing connection (${reason})`);
    wsClient.close();
  };
  const shutdownAndExit = async (reason, code = 0) => {
    closeConnection(reason);
    await inbox.idle();
    await meetingObserver.idle();
    await meetingIngest.idle();
    await projectMemberSync.idle();
    await runtime.sourceDeliveryPollPromise;
    await documentEvents.stop();
    await cardsStopped;
    await releasePidLock();
    process.exit(code);
  };

  process.on('SIGINT', () => {
    void shutdownAndExit('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdownAndExit('SIGTERM');
  });

  const displayChanged = createFeishuDisplayEventWriter({ configDir: CONFIG_DIR, realm: config.sourceRouteId });
  const displayHint = type => async raw => { await displayChanged(type, raw); return {}; };
  const persist = (sourceLabel, summarize) => async raw => {
    const receivedAt = performance.now();
    const summary = summarize(raw);
    if (summary.fileToken && await documentEvents.accept(summary)) return {};
    const status = participationEnabled(runtime, summary) ? await participationController(runtime).state(summary) : null;
    const accepted = await inbox.accept(summary.messageId || summary.eventId, { summary, raw, sourceLabel,
      ...(status ? { participationSnapshot: { key: status.key, mode: status.mode, epoch: status.epoch, receivedAt: Date.now() } } : {}),
    });
    if (!accepted.complete && await isAllowedByPolicy(config.accessPolicy, summary)) {
      if (sourceLabel === 'im.message.receive_v1') await displayChanged(sourceLabel, raw);
      if (participationEnabled(runtime, summary) && (
        (await participationController(runtime).state(summary)).mode !== 'active'
        || parseParticipationText(summary.messageText || summary.textPreview))) return {};
      const routed = await shouldRouteFeishuMessageToRemoteLab(runtime, summary,
        { explicitCommand: !!extractLocalCommand(summary) });
      if (routed && !resolveFeishuGroupSettings(config, summary).jevReactions) {
        quickParticipation.handle(summary, { receivedAt });
      }
      else if (discussionHandoffLink(runtime, summary)
        && !(await getFeishuConversationSettings(runtime, summary)).muted
        && (!participationEnabled(runtime, summary)
          || (await participationController(runtime).state(summary)).mode !== 'paused')) {
        // Unbound discussion-thread replies still provide handoff signals and
        // context. Scan without suggesting that the Bot will answer the thread.
        quickParticipation.handle(summary, { receivedAt, reactionMode: 'none' });
      }
    }
    return {};
  };
  const persistReactionFeedback = async raw => {
    const event = raw?.event && typeof raw.event === 'object' ? raw.event : raw;
    const messageId = trimString(event?.message_id);
    if (!messageId) return {};
    const outbound = await findConnectorMessageIndexRecord(storagePaths.messageIndexPath, {
      connector: FEISHU_CONNECTOR_ID,
      accountId: trimString(event.tenant_key || raw?.header?.tenant_key),
      messageId,
    });
    const feedbackChats = new Set(Object.entries(config.groups || {})
      .filter(([, settings]) => settings.reactionFeedback === true).map(([chatId]) => chatId));
    const summary = summarizeFeishuReactionFeedback(raw, outbound, { feedbackChats });
    if (!summary) return {};
    await inbox.accept(`reaction:${summary.eventId}`, {
      summary, raw, sourceLabel: 'im.message.reaction.created_v1',
    });
    return {};
  };
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    ...projectMemberSync.handlers,
    ...meetingObserver.handlers,
    'im.chat.access_event.bot_p2p_chat_entered_v1': async raw => {
      const summary = summarizePersonalChatEntered(raw);
      if (summary && runtime.personalSettings.enabled(summary)) {
        await inbox.accept(summary.messageId, { raw, summary, sourceLabel: 'im.chat.access_event.bot_p2p_chat_entered_v1' });
      }
      return {};
    },
    'im.message.receive_v1': persist('im.message.receive_v1', summarizeEvent),
    'im.chat.member.bot.added_v1': async raw => {
      const event = raw.event || raw;
      const eventId = raw.header?.event_id || event.event_id;
      const chatId = event.chat_id;
      if (!chatId || !eventId) return {};
      const tenantKey = raw.header?.tenant_key || event.tenant_key || event.operator_tenant_key || '';
      await inbox.accept(`bot-added:${eventId}`, { raw, sourceLabel: 'im.chat.member.bot.added_v1', summary: {
        sourceKind: 'bot_added', eventId, messageId: `bot-added:${eventId}`, chatId,
        chatType: 'group', chatMode: 'group', conversationKind: 'main', tenantKey,
        sender: { senderType: 'user', openId: event.operator_id?.open_id || '', tenantKey },
      } });
      return {};
    },
    'im.message.message_read_v1': async raw => {
      await displayChanged('im.message.message_read_v1', raw);
      return handleFeishuCardReadEvent(runtime, raw);
    },
    'im.message.recalled_v1': displayHint('im.message.recalled_v1'),
    'calendar.calendar.changed_v4': displayHint('calendar.calendar.changed_v4'),
    'calendar.calendar.event.changed_v4': displayHint('calendar.calendar.event.changed_v4'),
    'card.action.trigger': async raw => {
      const automationFeedback = await handleAutomationCardAction(runtime, raw, {
        request: (path, options) => requestRemoteLab(runtime, path, options),
        authorize: summary => isAllowedByPolicy(config.accessPolicy, summary),
      });
      if (automationFeedback) return automationFeedback;
      const personalFeedback = await runtime.personalSettings.action(raw);
      if (personalFeedback) return personalFeedback;
      const memoryFeedback = await handleMemoryReviewCardAction(runtime, raw, {
        authorize: summary => isAllowedByPolicy(config.accessPolicy, summary),
      });
      if (memoryFeedback) return memoryFeedback;
      const questionFeedback = await handleNativeQuestionCardAction(runtime, raw, {
        request: (path, options) => requestRemoteLab(runtime, path, options),
        authorize: summary => isAllowedByPolicy(config.accessPolicy, summary),
      });
      if (questionFeedback) return questionFeedback;
      const progressFeedback = await handleFeishuProgressPolicyAction(runtime, raw, {
        request: (path, options) => requestRemoteLab(runtime, path, options),
        authorize: summary => isAllowedByPolicy(config.accessPolicy, summary),
      });
      if (progressFeedback) return progressFeedback;
      const configurationFeedback = await runtime.groupConfiguration?.action(raw);
      if (configurationFeedback) return configurationFeedback;
      const participationFeedback = await runtime.participation?.action(raw);
      if (participationFeedback) return participationFeedback;
      const projectFeedback = await runtime.projectSurface?.actionFeedback(raw);
      if (projectFeedback) {
        if (projectFeedback.accepted) void runtime.projectSurface.handleAction(raw).catch(error =>
          console.warn(`[feishu-project] card action failed: ${error.message}`));
        return { toast: projectFeedback.toast };
      }
      const feedback = await discussionHandoff.actionFeedback(raw);
      if (feedback.accepted) {
        void discussionHandoff.handleAction(raw).catch(error =>
          console.warn(`[feishu-handoff] card action failed: ${error?.message || error}`));
      }
      return { toast: feedback.toast };
    },
    'im.message.reaction.created_v1': persistReactionFeedback,
    'drive.notice.comment_add_v1': persist('drive.notice.comment_add_v1', summarizeFeishuDocumentCommentEvent),
  });
  inbox.start();
  await meetingIngest.start();
  await wsClient.start({ eventDispatcher });
  if (closed) return;
  await projectMemberSync.start();
  cardRecovery = startFeishuCardRecovery({
    startWorkboards: async () => (runtime.workboards = await startFeishuWorkboards(runtime, {
      configDir: CONFIG_DIR, configPath: options.configPath,
      remote: { baseUrl: config.chatBaseUrl,
        request: (path, options) => requestRemoteLab(runtime, path, options),
        ensureAuthCookie: () => ensureAuthCookie(runtime) },
    })),
    startProjectCards: async () => (runtime.projectCards = await startProjectGroupCards(runtime, {
      request: (path, options) => requestRemoteLab(runtime, path, options),
      ensureAuthCookie: () => ensureAuthCookie(runtime),
      onboard: (summary, options) => onboardFeishuGroup(runtime, summary, options),
      participation: () => participationController(runtime),
    })),
    restoreParticipation: shouldContinue => {
      if (['active', 'listening', 'paused'].includes(config.defaultGroupParticipation)
          || Object.values(config.groups || {}).some(group => group.participationControls
            || ['active', 'listening', 'paused'].includes(group.participationMode))) {
        return participationController(runtime).restore({ shouldContinue });
      }
    },
  });
  void meetingObserver.restore().catch(error =>
    console.warn(`[feishu-meeting] restore failed: ${error.message}`));
  void runtime.projectSurface?.restore().catch(error =>
    console.warn(`[feishu-project] restore failed: ${error.message}`));
  void discussionHandoff.restore().catch(error =>
    console.warn(`[feishu-handoff] restore failed: ${error?.message || error}`));
  startSourceDeliveryPoller(runtime);
  void reconcileKnownFeishuPeople(runtime)
    .then(({ checked, matched }) => {
      if (checked > 0) console.log(`[feishu-connector] person reconciliation complete (checked=${checked}, matched=${matched})`);
    })
    .catch((error) => console.warn(`[feishu-connector] person reconciliation failed: ${error?.message || error}`));
  console.log(`[feishu-connector] persistent connection ready (${config.region})`);
  console.log(`[feishu-connector] access policy: ${config.accessPolicy.mode}`);
  console.log(`[feishu-connector] response policy: ${JSON.stringify(config.responsePolicy)}`);
  console.log(`[feishu-connector] whitelist mirror: ${config.accessPolicy.allowedSendersPath}`);
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
