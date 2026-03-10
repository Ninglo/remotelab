#!/usr/bin/env node

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';

const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'remotelab', 'feishu-connector', 'config.json');
const DEFAULT_TAIL = 5;
const WATCH_INTERVAL_MS = 1000;

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    tail: DEFAULT_TAIL,
    watchSeconds: 0,
    match: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      options.configPath = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--tail') {
      options.tail = parseInteger(argv[index + 1], '--tail', 0);
      index += 1;
      continue;
    }
    if (arg === '--watch') {
      options.watchSeconds = parseInteger(argv[index + 1], '--watch', 0);
      index += 1;
      continue;
    }
    if (arg === '--match') {
      options.match = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      printUsage(0);
    }
    printUsage(1, `Unknown argument: ${arg}`);
  }

  if (!options.configPath) {
    throw new Error('Missing config path');
  }

  return options;
}

function parseInteger(value, flagName, minimum) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${flagName} value: ${value || '(missing)'}`);
  }
  return parsed;
}

function printUsage(exitCode, errorMessage = '') {
  if (errorMessage) {
    console.error(errorMessage);
    console.error('');
  }
  const output = exitCode === 0 ? console.log : console.error;
  output(`Usage:
  node scripts/feishu-check.mjs [options]

Options:
  --config <path>   Config file path (default: ${DEFAULT_CONFIG_PATH})
  --tail <n>        Number of recent events to show (default: ${DEFAULT_TAIL})
  --watch <sec>     Watch for new events for N seconds
  --match <text>    Match text against preview, IDs, and sender fields
  -h, --help        Show this help

Examples:
  node scripts/feishu-check.mjs
  node scripts/feishu-check.mjs --watch 15
  node scripts/feishu-check.mjs --match test-4821 --watch 15`);
  process.exit(exitCode);
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

async function loadPaths(configPath) {
  const configDir = dirname(configPath);
  const configRaw = await readTextIfExists(configPath);
  let storageDir = configDir;

  if (configRaw) {
    const parsed = JSON.parse(configRaw);
    const configuredStorageDir = String(parsed?.storageDir || '').trim();
    if (configuredStorageDir) {
      storageDir = configuredStorageDir;
    }
  }

  return {
    configPath,
    configDir,
    storageDir,
    pidPath: join(configDir, 'connector.pid'),
    logPath: join(configDir, 'connector.log'),
    eventLogPath: join(storageDir, 'events.jsonl'),
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

function parseJsonLines(raw) {
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

async function readEventRecords(eventLogPath) {
  const raw = await readTextIfExists(eventLogPath);
  const exists = raw !== null;
  const { records, invalidLines } = parseJsonLines(raw);
  return { exists, records, invalidLines };
}

function collectSearchFields(record) {
  const summary = record?.summary || {};
  const sender = summary?.sender || {};
  const mentions = Array.isArray(summary?.mentions) ? summary.mentions : [];
  const fields = [
    record?.sourceLabel,
    record?.receivedAt,
    record?.allowed === true ? 'allowed' : record?.allowed === false ? 'blocked' : '',
    summary?.eventId,
    summary?.eventType,
    summary?.chatId,
    summary?.chatType,
    summary?.messageId,
    summary?.threadId,
    summary?.rootId,
    summary?.parentId,
    summary?.tenantKey,
    sender?.openId,
    sender?.userId,
    sender?.unionId,
    sender?.tenantKey,
    sender?.senderType,
    summary?.textPreview,
    summary?.rawContent,
  ];

  for (const mention of mentions) {
    fields.push(mention?.key, mention?.name, mention?.openId, mention?.userId, mention?.unionId, mention?.tenantKey);
  }

  return fields.map((value) => String(value || '')).filter(Boolean);
}

function filterRecords(records, matchText) {
  if (!matchText) return records;
  const query = matchText.toLowerCase();
  return records.filter((record) => collectSearchFields(record).some((field) => field.toLowerCase().includes(query)));
}

function truncate(value, limit = 80) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function formatEventLine(record) {
  const summary = record?.summary || {};
  const text = truncate(summary?.textPreview || summary?.rawContent || '', 90);
  const status = record?.allowed === false ? 'blocked' : 'allowed';
  const parts = [
    record?.receivedAt || 'unknown-time',
    record?.sourceLabel || summary?.eventType || 'unknown-source',
    status,
    summary?.chatType || 'unknown-chat',
    summary?.messageId ? `message=${summary.messageId}` : '',
    summary?.chatId ? `chat=${summary.chatId}` : '',
    summary?.sender?.openId ? `sender=${summary.sender.openId}` : summary?.sender?.userId ? `sender=${summary.sender.userId}` : '',
    text ? `text="${text}"` : '',
  ].filter(Boolean);
  return `- ${parts.join(' | ')}`;
}

function summarizeSnapshot(snapshot, options) {
  const relevantRecords = options.match ? snapshot.matchedRecords : snapshot.records;
  const latestRecord = relevantRecords[relevantRecords.length - 1] || null;
  const allowedCount = relevantRecords.filter((record) => record?.allowed !== false).length;
  const blockedCount = relevantRecords.length - allowedCount;

  return {
    relevantRecords,
    latestRecord,
    allowedCount,
    blockedCount,
  };
}

async function collectSnapshot(options) {
  const paths = await loadPaths(options.configPath);
  const connector = await readConnectorStatus(paths.pidPath);
  const eventLog = await readEventRecords(paths.eventLogPath);
  const matchedRecords = filterRecords(eventLog.records, options.match);
  return {
    paths,
    connector,
    eventLog,
    records: eventLog.records,
    matchedRecords,
  };
}

function printSnapshot(snapshot, options) {
  const summary = summarizeSnapshot(snapshot, options);
  const connectorLabel = snapshot.connector.running
    ? `running${snapshot.connector.pid ? ` (pid ${snapshot.connector.pid})` : ''}`
    : 'not running';
  const targetLabel = options.match ? `matching events for "${options.match}"` : 'inbound events';

  console.log(`Feishu connector: ${connectorLabel}`);
  console.log(`Config: ${snapshot.paths.configPath}`);
  console.log(`Storage: ${snapshot.paths.storageDir}`);
  console.log(`Event log: ${snapshot.paths.eventLogPath}${snapshot.eventLog.exists ? '' : ' (missing)'}`);

  if (snapshot.eventLog.invalidLines > 0) {
    console.log(`Event log warnings: ${snapshot.eventLog.invalidLines} invalid JSONL line(s)`);
  }

  if (summary.relevantRecords.length === 0) {
    console.log(`Result: NO ${targetLabel}.`);
    if (!options.match && snapshot.records.length > 0) {
      console.log(`Recorded events exist, but none matched the current filter.`);
    }
    return;
  }

  console.log(`Result: YES — ${summary.relevantRecords.length} ${targetLabel}.`);
  console.log(`Allowed: ${summary.allowedCount} | Blocked: ${summary.blockedCount}`);
  if (summary.latestRecord) {
    console.log(`Latest: ${formatEventLine(summary.latestRecord).slice(2)}`);
  }

  if (options.tail > 0) {
    console.log(`Recent:`);
    for (const record of summary.relevantRecords.slice(-options.tail)) {
      console.log(formatEventLine(record));
    }
  }
}

function exitCodeForSnapshot(snapshot, options) {
  const relevantCount = options.match ? snapshot.matchedRecords.length : snapshot.records.length;
  return relevantCount > 0 ? 0 : 1;
}

async function watchForNewEvents(baseline, options) {
  const deadline = Date.now() + (options.watchSeconds * 1000);
  const baselineCount = options.match ? baseline.matchedRecords.length : baseline.records.length;

  console.log(`Watching ${options.watchSeconds}s for new ${options.match ? 'matching ' : ''}events...`);

  while (Date.now() < deadline) {
    await sleep(WATCH_INTERVAL_MS);
    const nextSnapshot = await collectSnapshot(options);
    const currentCount = options.match ? nextSnapshot.matchedRecords.length : nextSnapshot.records.length;
    if (currentCount <= baselineCount) {
      continue;
    }

    const nextRecords = options.match
      ? nextSnapshot.matchedRecords.slice(baselineCount)
      : nextSnapshot.records.slice(baselineCount);
    console.log(`New events detected:`);
    for (const record of nextRecords) {
      console.log(formatEventLine(record));
    }
    return 0;
  }

  console.log(`No new ${options.match ? 'matching ' : ''}events during the watch window.`);
  return 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = await collectSnapshot(options);
  printSnapshot(snapshot, options);

  if (options.watchSeconds > 0) {
    process.exit(await watchForNewEvents(snapshot, options));
  }

  process.exit(exitCodeForSnapshot(snapshot, options));
}

main().catch((error) => {
  console.error(`[feishu-check] ${error?.message || error}`);
  process.exit(2);
});
