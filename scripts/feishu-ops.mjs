#!/usr/bin/env node

import { execFile as execFileCallback } from 'child_process';
import { access, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import {
  createRemoteLabHttpClient,
  DEFAULT_CHAT_BASE_URL,
  DEFAULT_RUN_POLL_TIMEOUT_MS,
  loadAssistantReply,
  normalizeBaseUrl,
  parsePositiveInteger,
  trimString,
} from '../lib/remotelab-http-client.mjs';
import {
  createRuntimeContext,
  loadConfig,
  loadPersistedAccessState,
  normalizeReplyText,
} from './feishu-connector.mjs';

const execFile = promisify(execFileCallback);

const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'remotelab', 'feishu-connector', 'config.json');
const DEFAULT_ALLOWED_SENDERS_FILENAME = 'allowed-senders.json';
const DEFAULT_STATUS_TAIL = 5;
const DEFAULT_BACKFILL_COUNT = 2;
const DEFAULT_BACKFILL_TOOL = 'micro-agent';
const DEFAULT_BACKFILL_MODEL = 'gpt-5.4';
const DEFAULT_BACKFILL_EFFORT = 'low';
const DEFAULT_LAUNCHD_LABEL = 'com.remotelab.feishu-connector';

const SOURCE_ID = 'feishu-manual-backfill';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function printUsage(exitCode, errorMessage = '') {
  if (errorMessage) {
    console.error(errorMessage);
    console.error('');
  }

  const output = exitCode === 0 ? console.log : console.error;
  output(`Usage:
  node scripts/feishu-ops.mjs <command> [options]

Commands:
  status               Show connector runtime, process state, and recent silent replies
  restart              Restart the connector and show status
  backfill             Create a fresh reply session for recent silent text messages

Options:
  --config <path>      Config file path (default: ${DEFAULT_CONFIG_PATH})
  --tail <n>           Number of recent entries to show for status (default: ${DEFAULT_STATUS_TAIL})
  --count <n>          Number of silent messages to use for backfill (default: ${DEFAULT_BACKFILL_COUNT})
  --chat-id <id>       Target a specific chat for backfill
  --message-id <id>    Target a specific message for backfill
  --tool <id>          Tool for backfill sessions (default: ${DEFAULT_BACKFILL_TOOL})
  --model <id>         Model for backfill sessions (default: ${DEFAULT_BACKFILL_MODEL})
  --effort <level>     Effort for backfill sessions (default: ${DEFAULT_BACKFILL_EFFORT})
  --base-url <url>     RemoteLab base URL (default: ${DEFAULT_CHAT_BASE_URL})
  --timeout-ms <ms>    Wait timeout for the backfill run (default: ${DEFAULT_RUN_POLL_TIMEOUT_MS})
  --dry-run            Build the backfill target and prompt, but do not create a session
  --no-send            Generate the reply draft but do not send it to Feishu
  -h, --help           Show this help

Examples:
  node scripts/feishu-ops.mjs status
  node scripts/feishu-ops.mjs restart
  node scripts/feishu-ops.mjs backfill --count 2 --tool micro-agent --model gpt-5.4 --effort low
  node scripts/feishu-ops.mjs backfill --message-id om_xxx --dry-run`);
  process.exit(exitCode);
}

export function parseArgs(argv = []) {
  const options = {
    command: '',
    configPath: DEFAULT_CONFIG_PATH,
    tail: DEFAULT_STATUS_TAIL,
    count: DEFAULT_BACKFILL_COUNT,
    chatId: '',
    messageId: '',
    tool: DEFAULT_BACKFILL_TOOL,
    model: DEFAULT_BACKFILL_MODEL,
    effort: DEFAULT_BACKFILL_EFFORT,
    baseUrl: trimString(process.env.REMOTELAB_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
    timeoutMs: DEFAULT_RUN_POLL_TIMEOUT_MS,
    dryRun: false,
    send: true,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--config':
        options.configPath = argv[index + 1] || '';
        index += 1;
        break;
      case '--tail':
        options.tail = parsePositiveInteger(argv[index + 1], DEFAULT_STATUS_TAIL);
        index += 1;
        break;
      case '--count':
        options.count = parsePositiveInteger(argv[index + 1], DEFAULT_BACKFILL_COUNT);
        index += 1;
        break;
      case '--chat-id':
        options.chatId = argv[index + 1] || '';
        index += 1;
        break;
      case '--message-id':
        options.messageId = argv[index + 1] || '';
        index += 1;
        break;
      case '--tool':
        options.tool = argv[index + 1] || '';
        index += 1;
        break;
      case '--model':
        options.model = argv[index + 1] || '';
        index += 1;
        break;
      case '--effort':
        options.effort = argv[index + 1] || '';
        index += 1;
        break;
      case '--base-url':
        options.baseUrl = argv[index + 1] || '';
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInteger(argv[index + 1], DEFAULT_RUN_POLL_TIMEOUT_MS);
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-send':
        options.send = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        positional.push(arg);
        break;
    }
  }

  options.command = trimString(positional[0]).toLowerCase();
  options.configPath = trimString(options.configPath);
  options.chatId = trimString(options.chatId);
  options.messageId = trimString(options.messageId);
  options.tool = trimString(options.tool) || DEFAULT_BACKFILL_TOOL;
  options.model = trimString(options.model) || DEFAULT_BACKFILL_MODEL;
  options.effort = trimString(options.effort) || DEFAULT_BACKFILL_EFFORT;
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTextIfExists(pathname) {
  try {
    return await readFile(pathname, 'utf8');
  } catch {
    return null;
  }
}

async function readJsonIfExists(pathname, fallback = null) {
  const raw = await readTextIfExists(pathname);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function pathExists(pathname) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

function resolveOptionalPath(value, baseDir, fallbackPath) {
  const normalized = String(value || '').trim();
  if (!normalized) return fallbackPath;
  if (normalized.startsWith('~')) {
    return join(homedir(), normalized.slice(1));
  }
  if (normalized.startsWith('/')) {
    return normalized;
  }
  return resolve(baseDir, normalized);
}

async function loadPaths(configPath) {
  const configDir = dirname(configPath);
  const configRaw = await readTextIfExists(configPath);
  let storageDir = configDir;
  let allowedSendersPath = join(configDir, DEFAULT_ALLOWED_SENDERS_FILENAME);
  if (configRaw) {
    const parsed = JSON.parse(configRaw);
    if (trimString(parsed?.storageDir)) {
      storageDir = trimString(parsed.storageDir);
    }
    allowedSendersPath = resolveOptionalPath(parsed?.intakePolicy?.allowedSendersPath, configDir, allowedSendersPath);
  }

  return {
    configPath,
    configDir,
    storageDir,
    allowedSendersPath,
    pidPath: join(configDir, 'connector.pid'),
    connectorLogPath: join(configDir, 'connector.log'),
    launchdStdoutPath: join(configDir, 'launchd.stdout.log'),
    launchdStderrPath: join(configDir, 'launchd.stderr.log'),
    eventLogPath: join(storageDir, 'events.jsonl'),
    handledMessagesPath: join(storageDir, 'handled-messages.json'),
    knownSendersPath: join(storageDir, 'known-senders.json'),
    launchdPlistPath: join(homedir(), 'Library', 'LaunchAgents', `${DEFAULT_LAUNCHD_LABEL}.plist`),
  };
}

async function readConnectorStatus(pidPath) {
  const rawPid = await readTextIfExists(pidPath);
  const pid = Number.parseInt(String(rawPid || '').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { running: false, pid: null };
  }

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid };
  }
}

export function parseJsonLines(raw) {
  if (!raw) {
    return { records: [], invalidLines: 0 };
  }

  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  const records = [];
  let invalidLines = 0;

  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      invalidLines += 1;
    }
  }

  return { records, invalidLines };
}

export function buildMessageRecords(eventRecords = [], handledState = {}) {
  return eventRecords
    .map((record) => {
      const summary = record?.summary || {};
      return {
        receivedAt: trimString(record?.receivedAt),
        sourceLabel: trimString(record?.sourceLabel || summary?.eventType),
        allowed: record?.allowed !== false,
        messageId: trimString(summary?.messageId),
        chatId: trimString(summary?.chatId),
        chatType: trimString(summary?.chatType),
        messageType: trimString(summary?.messageType),
        text: trimString(summary?.textPreview),
        contentSummary: trimString(summary?.contentSummary),
        senderOpenId: trimString(summary?.sender?.openId),
        handled: summary?.messageId ? handledState?.[summary.messageId] || null : null,
      };
    })
    .filter((record) => record.messageId && record.chatId);
}

function truncate(text, limit = 120) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function formatRecordLine(record) {
  const status = record.allowed ? 'allowed' : 'blocked';
  const handledStatus = trimString(record?.handled?.status) || 'unhandled';
  const text = truncate(record.text || record.contentSummary || '', 100);
  const parts = [
    record.receivedAt || 'unknown-time',
    record.sourceLabel || 'unknown-source',
    status,
    record.chatType || 'unknown-chat',
    record.messageId ? `message=${record.messageId}` : '',
    record.chatId ? `chat=${record.chatId}` : '',
    handledStatus ? `handled=${handledStatus}` : '',
    text ? `text="${text}"` : '',
  ].filter(Boolean);
  return `- ${parts.join(' | ')}`;
}

function collectSilentTextRecords(records = []) {
  return records.filter((record) => record.allowed && record.messageType === 'text' && record?.handled?.status === 'silent_no_reply');
}

function collectUnhandledTextRecords(records = []) {
  return records.filter((record) => record.allowed && record.messageType === 'text' && !record.handled);
}

export function selectBackfillMessages(records = [], options = {}) {
  const candidates = collectSilentTextRecords(records);
  if (candidates.length === 0) {
    return { chatId: '', messages: [] };
  }

  const count = Math.max(1, Number.parseInt(String(options.count || DEFAULT_BACKFILL_COUNT), 10) || DEFAULT_BACKFILL_COUNT);

  if (trimString(options.messageId)) {
    const target = candidates.find((record) => record.messageId === options.messageId);
    if (!target) {
      return { chatId: '', messages: [] };
    }
    const sameChat = candidates.filter((record) => record.chatId === target.chatId);
    const targetIndex = sameChat.findIndex((record) => record.messageId === target.messageId);
    const startIndex = Math.max(0, targetIndex - count + 1);
    return {
      chatId: target.chatId,
      messages: sameChat.slice(startIndex, targetIndex + 1),
    };
  }

  const chatId = trimString(options.chatId) || candidates.at(-1)?.chatId || '';
  if (!chatId) {
    return { chatId: '', messages: [] };
  }

  const sameChat = candidates.filter((record) => record.chatId === chatId);
  return {
    chatId,
    messages: sameChat.slice(-count),
  };
}

export function buildBackfillPrompt(messages = []) {
  const normalizedMessages = Array.isArray(messages) ? messages.filter((message) => trimString(message?.text || message?.contentSummary)) : [];
  const header = normalizedMessages.length === 1
    ? '下面是同一个飞书聊天里之前收到但没有回复的一条消息：'
    : `下面是同一个飞书聊天里之前收到但没有回复的 ${normalizedMessages.length} 条消息：`;
  const messageLines = normalizedMessages.map((message, index) => `${index + 1}. ${trimString(message.text || message.contentSummary)}`);
  return [
    header,
    ...messageLines,
    '',
    '请只输出一条适合现在直接发回该飞书聊天的中文消息，要求：',
    '- 先简短说明刚补看到前面的消息',
    '- 明确复述已经收到的关键信息',
    '- 语气自然，不要解释技术原因',
    '- 不要输出 markdown、项目符号、引号或额外说明',
    '- 不超过 120 个汉字',
  ].join('\n');
}

export function formatFeishuApiError(error) {
  const apiPayload = error?.response?.data || error?.data || {};
  const code = apiPayload?.code;
  const message = trimString(apiPayload?.msg || error?.message || String(error));
  if (code !== undefined && code !== null && message) {
    return `${message} (code ${code})`;
  }
  return message || 'Unknown Feishu API error';
}

async function loadSnapshot(options = {}) {
  const paths = await loadPaths(options.configPath || DEFAULT_CONFIG_PATH);
  const config = await loadConfig(paths.configPath);
  const accessState = await loadPersistedAccessState(config.intakePolicy);
  const connector = await readConnectorStatus(paths.pidPath);
  const eventsRaw = await readTextIfExists(paths.eventLogPath);
  const handledJson = await readJsonIfExists(paths.handledMessagesPath, { messages: {} });
  const { records: eventRecords, invalidLines } = parseJsonLines(eventsRaw);
  const records = buildMessageRecords(eventRecords, handledJson?.messages || {});
  return {
    paths,
    config,
    accessState,
    connector,
    records,
    invalidLines,
    rawEventCount: eventRecords.length,
  };
}

async function printStatus(snapshot, options = {}) {
  const allowedCount = snapshot.records.filter((record) => record.allowed).length;
  const blockedCount = snapshot.records.length - allowedCount;
  const latestRecord = snapshot.records.at(-1) || null;
  const silentText = collectSilentTextRecords(snapshot.records);
  const unhandledText = collectUnhandledTextRecords(snapshot.records);
  const logPath = await pathExists(snapshot.paths.launchdStdoutPath)
    ? snapshot.paths.launchdStdoutPath
    : snapshot.paths.connectorLogPath;

  console.log(`Feishu connector: ${snapshot.connector.running ? `running (pid ${snapshot.connector.pid})` : 'not running'}`);
  console.log(`Config: ${snapshot.paths.configPath}`);
  console.log(`Runtime: tool=${snapshot.config.sessionTool || '(none)'} model=${snapshot.config.model || '(default)'} effort=${snapshot.config.effort || '(default)'} thinking=${snapshot.config.thinking ? 'on' : 'off'}`);
  console.log(`RemoteLab: base=${snapshot.config.chatBaseUrl} folder=${snapshot.config.sessionFolder}`);
  console.log(`Logs: ${logPath}`);
  console.log(`Events: ${snapshot.records.length} parsed (${allowedCount} allowed | ${blockedCount} blocked)`);
  if (snapshot.invalidLines > 0) {
    console.log(`Event log warnings: ${snapshot.invalidLines} invalid JSONL line(s)`);
  }
  console.log(`Silent text replies: ${silentText.length}`);
  console.log(`Unhandled text replies: ${unhandledText.length}`);
  if (latestRecord) {
    console.log(`Latest inbound: ${formatRecordLine(latestRecord).slice(2)}`);
  }
  if (options.tail > 0) {
    console.log('Recent silent text messages:');
    const recentSilent = silentText.slice(-options.tail);
    if (recentSilent.length === 0) {
      console.log('- none');
    } else {
      for (const record of recentSilent) {
        console.log(formatRecordLine(record));
      }
    }
  }
}

async function createBackfillSession(client, snapshot, options) {
  const sourceName = snapshot.config.region === 'lark-global' ? 'Lark' : 'Feishu';
  const result = await client.request('/api/sessions', {
    method: 'POST',
    body: {
      folder: snapshot.config.sessionFolder || homedir(),
      tool: options.tool,
      name: 'Feishu backlog catch-up',
      sourceId: SOURCE_ID,
      sourceName,
      group: 'Feishu',
      description: 'Manual catch-up reply for previously silent connector messages',
      systemPrompt: 'You are replying through a Feishu bot on the user\'s own machine. Output exactly one plain-text Chinese message that is safe to send back into Feishu right now. Keep it concise, natural, and free of technical details. Do not output markdown, bullets, quotes, emoji, emoticons, sticker aliases like [委屈], or explanation.',
    },
  });
  if (!result.response.ok || !result.json?.session?.id) {
    throw new Error(result.json?.error || result.text || `Failed to create backfill session (${result.response.status})`);
  }
  return result.json.session;
}

async function generateBackfillReply(client, snapshot, selection, options) {
  const session = await createBackfillSession(client, snapshot, options);
  const prompt = buildBackfillPrompt(selection.messages);
  const messageResult = await client.request(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
    method: 'POST',
    body: {
      text: prompt,
      tool: options.tool,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
    },
  });
  if (![200, 202].includes(messageResult.response.status) || !messageResult.json?.run?.id) {
    throw new Error(messageResult.json?.error || messageResult.text || `Failed to submit backfill message (${messageResult.response.status})`);
  }

  const run = await client.waitForRun(messageResult.json.run.id, { timeoutMs: options.timeoutMs });
  const reply = normalizeReplyText(await loadAssistantReply(client, session.id, run.id));
  return {
    sessionId: session.id,
    sessionUrl: `/?session=${encodeURIComponent(session.id)}&tab=sessions`,
    runId: run.id,
    requestId: trimString(messageResult.json.requestId),
    prompt,
    reply,
  };
}

async function sendReplyToFeishu(snapshot, chatId, replyText) {
  const runtime = createRuntimeContext({
    ...snapshot.config,
    loggerLevel: 'error',
  }, {
    eventsLogPath: snapshot.paths.eventLogPath,
    knownSendersPath: snapshot.paths.knownSendersPath,
    handledMessagesPath: snapshot.paths.handledMessagesPath,
  }, snapshot.accessState);

  const response = await runtime.appClient.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: replyText }),
      uuid: `mb-${Date.now()}`,
    },
  });
  if ((response.code !== undefined && response.code !== 0) || !response.data?.message_id) {
    throw Object.assign(new Error(response.msg || 'Failed to send Feishu reply'), { response: { data: response } });
  }
  return response.data;
}

async function markMessagesBackfilled(pathname, messages, metadata) {
  const state = await readJsonIfExists(pathname, { messages: {} });
  const next = state && typeof state === 'object' ? state : { messages: {} };
  if (!next.messages || typeof next.messages !== 'object') {
    next.messages = {};
  }

  const now = new Date().toISOString();
  for (const message of messages) {
    const previous = next.messages[message.messageId] || {};
    next.messages[message.messageId] = {
      ...previous,
      status: 'manual_backfill_sent',
      previousStatus: previous.status || '',
      sourceLabel: 'manual-backfill',
      chatId: metadata.chatId,
      sessionId: metadata.sessionId,
      runId: metadata.runId,
      requestId: metadata.requestId,
      responseMessageId: metadata.responseMessageId,
      repliedAt: now,
      handledAt: now,
    };
  }

  await writeFile(pathname, JSON.stringify(next, null, 2));
}

async function runRestart(snapshot) {
  const usedLaunchd = process.platform === 'darwin' && await pathExists(snapshot.paths.launchdPlistPath);
  if (usedLaunchd) {
    const target = `gui/${process.getuid()}/${DEFAULT_LAUNCHD_LABEL}`;
    try {
      await execFile('launchctl', ['kickstart', '-k', target]);
    } catch {
      await execFile('launchctl', ['unload', snapshot.paths.launchdPlistPath]).catch(() => {});
      await execFile('launchctl', ['load', snapshot.paths.launchdPlistPath]);
    }
  } else {
    await execFile(join(REPO_ROOT, 'scripts', 'feishu-connector-instance.sh'), ['restart'], { cwd: REPO_ROOT });
  }

  await sleep(2500);
  const nextSnapshot = await loadSnapshot({ configPath: snapshot.paths.configPath });
  await printStatus(nextSnapshot, { tail: DEFAULT_STATUS_TAIL });
  if (!nextSnapshot.connector.running) {
    throw new Error('Connector restart did not produce a running process');
  }
}

async function runBackfill(snapshot, options) {
  const selection = selectBackfillMessages(snapshot.records, options);
  if (selection.messages.length === 0) {
    throw new Error('No matching silent text messages found for backfill');
  }

  console.log(`Target chat: ${selection.chatId}`);
  console.log('Selected messages:');
  for (const message of selection.messages) {
    console.log(formatRecordLine(message));
  }

  if (options.dryRun) {
    console.log('Backfill prompt:');
    console.log(buildBackfillPrompt(selection.messages));
    return;
  }

  const client = createRemoteLabHttpClient({ baseUrl: options.baseUrl || snapshot.config.chatBaseUrl });
  const generated = await generateBackfillReply(client, snapshot, selection, options);
  console.log(`Session: ${generated.sessionId}`);
  console.log(`Run: ${generated.runId}`);
  console.log(`Reply draft: ${generated.reply || '(empty)'}`);
  console.log(`Session URL: ${generated.sessionUrl}`);

  if (!generated.reply) {
    throw new Error('Backfill session returned an empty reply draft');
  }
  if (!options.send) {
    return;
  }

  try {
    const sent = await sendReplyToFeishu(snapshot, selection.chatId, generated.reply);
    await markMessagesBackfilled(snapshot.paths.handledMessagesPath, selection.messages, {
      chatId: selection.chatId,
      sessionId: generated.sessionId,
      runId: generated.runId,
      requestId: generated.requestId,
      responseMessageId: sent.message_id,
    });
    console.log(`Sent: ${sent.message_id}`);
  } catch (error) {
    throw new Error(`Feishu send failed for chat ${selection.chatId}: ${formatFeishuApiError(error)}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.command) {
    printUsage(options.help ? 0 : 1, options.help ? '' : 'A command is required');
  }

  const snapshot = await loadSnapshot({ configPath: options.configPath });
  switch (options.command) {
    case 'status':
      await printStatus(snapshot, options);
      return 0;
    case 'restart':
      await runRestart(snapshot);
      return 0;
    case 'backfill':
      await runBackfill(snapshot, options);
      return 0;
    default:
      printUsage(1, `Unknown command: ${options.command}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[feishu-ops] ${error?.message || error}`);
    process.exit(2);
  });
}
