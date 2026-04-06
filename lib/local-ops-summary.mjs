import { execFile as execFileCallback } from 'child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { homedir, hostname as osHostname, loadavg, totalmem, freemem, uptime, cpus } from 'os';
import { join } from 'path';
import http from 'http';
import https from 'https';
import { promisify } from 'util';

import { parseCloudflaredIngress } from './cloudflared-config.mjs';

const HOME = homedir();
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const TRIAL_INSTANCE_RE = /^trial\d*$/i;
const execFileAsync = promisify(execFileCallback);
const EMPTY_HOST_METRICS = {
  generatedAt: '',
  hostname: '',
  platform: process.platform,
  uptimeSeconds: 0,
  cpuCount: 0,
  loadAvg: { one: 0, five: 0, fifteen: 0 },
  cpuUserPercent: 0,
  cpuSysPercent: 0,
  cpuIdlePercent: 0,
  totalMemoryBytes: 0,
  freeMemoryBytes: 0,
  usedMemoryBytes: 0,
  memoryPressureFreePercent: null,
  swapins: 0,
  swapouts: 0,
  diskPath: '',
  diskTotalBytes: 0,
  diskUsedBytes: 0,
  diskAvailableBytes: 0,
  diskCapacityPercent: 0,
  topPhysMemLine: '',
  cpuStatus: 'low',
  memoryStatus: 'low',
  diskStatus: 'low',
  overallPressure: 'low',
};

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function naturalCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeReadText(filePath, fallback = '') {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

async function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDate(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
  if (!match) {
    throw new Error(`Invalid date: ${dateString}`);
  }
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, -1);
}

function defaultAnchorDate() {
  const anchor = new Date();
  anchor.setDate(anchor.getDate() - 1);
  return startOfDay(anchor);
}

export function resolveOpsWindow({ date, days = 1, nowMs = Date.now() } = {}) {
  const anchorDate = date ? parseLocalDate(date) : defaultAnchorDate();
  const normalizedDays = Number.isInteger(days) && days >= 1 ? days : 1;
  const anchorStart = startOfDay(anchorDate);
  const rangeStart = new Date(anchorStart);
  rangeStart.setDate(rangeStart.getDate() - (normalizedDays - 1));
  const rangeEnd = endOfDay(anchorDate);
  return {
    anchorDate: formatLocalDate(anchorStart),
    days: normalizedDays,
    startDate: formatLocalDate(rangeStart),
    endDate: formatLocalDate(anchorStart),
    startMs: rangeStart.getTime(),
    endMs: Math.min(rangeEnd.getTime(), nowMs),
    label: normalizedDays === 1
      ? formatLocalDate(anchorStart)
      : `${formatLocalDate(rangeStart)} → ${formatLocalDate(anchorStart)}`,
  };
}

function listWindowDates(window) {
  const result = [];
  const cursor = parseLocalDate(window.startDate);
  const end = parseLocalDate(window.endDate);
  while (cursor.getTime() <= end.getTime()) {
    result.push(formatLocalDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractPlistString(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`<key>${escaped}</key>\\s*<string>([\\s\\S]*?)</string>`));
  return decodeXmlEntities(match?.[1] || '');
}

function parseLaunchAgentPlist(content) {
  return {
    label: extractPlistString(content, 'Label'),
    port: Number.parseInt(extractPlistString(content, 'CHAT_PORT'), 10) || 0,
    instanceRoot: extractPlistString(content, 'REMOTELAB_INSTANCE_ROOT'),
    standardOutPath: extractPlistString(content, 'StandardOutPath'),
    standardErrorPath: extractPlistString(content, 'StandardErrorPath'),
  };
}

function extractServicePort(service) {
  const trimmed = trimString(service);
  if (!trimmed) return 0;
  try {
    const parsed = new URL(trimmed);
    const explicitPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return Number.parseInt(explicitPort, 10) || 0;
  } catch {
    return 0;
  }
}

async function buildCloudflaredPortMap(homeDir) {
  const cloudflaredPath = join(homeDir, '.cloudflared', 'config.yml');
  const content = await safeReadText(cloudflaredPath, '');
  const map = new Map();
  for (const entry of parseCloudflaredIngress(content)) {
    const port = extractServicePort(entry.service);
    if (!port) continue;
    const hostname = trimString(entry.hostname);
    if (hostname && !map.has(port)) {
      map.set(port, hostname);
    }
  }
  return map;
}

function normalizeBaseUrl(hostname) {
  const trimmed = trimString(hostname);
  return trimmed ? `https://${trimmed}` : '';
}

async function discoverChatServerServices({ homeDir = HOME } = {}) {
  const launchAgentsDir = join(homeDir, 'Library', 'LaunchAgents');
  const cloudMap = await buildCloudflaredPortMap(homeDir);
  const services = [];
  const ownerPlistPath = join(launchAgentsDir, 'com.chatserver.claude.plist');

  if (await pathExists(ownerPlistPath)) {
    const ownerPlist = parseLaunchAgentPlist(await safeReadText(ownerPlistPath, ''));
    services.push({
      name: 'owner',
      label: ownerPlist.label || 'com.chatserver.claude',
      kind: 'owner',
      port: ownerPlist.port || 7690,
      hostname: cloudMap.get(ownerPlist.port || 7690) || '',
      publicBaseUrl: normalizeBaseUrl(cloudMap.get(ownerPlist.port || 7690) || ''),
      localBaseUrl: `http://127.0.0.1:${ownerPlist.port || 7690}`,
      instanceRoot: ownerPlist.instanceRoot,
      logPath: ownerPlist.standardOutPath,
      errorLogPath: ownerPlist.standardErrorPath,
    });
  } else {
    services.push({
      name: 'owner',
      label: 'com.chatserver.owner',
      kind: 'owner',
      port: 7690,
      hostname: cloudMap.get(7690) || '',
      publicBaseUrl: normalizeBaseUrl(cloudMap.get(7690) || ''),
      localBaseUrl: 'http://127.0.0.1:7690',
      instanceRoot: '',
      logPath: '',
      errorLogPath: '',
    });
  }

  if (!await pathExists(launchAgentsDir)) {
    return services;
  }

  for (const fileName of (await readdir(launchAgentsDir)).filter((entry) => /^com\.chatserver\..+\.plist$/.test(entry))) {
    if (fileName === 'com.chatserver.claude.plist') continue;
    const parsed = parseLaunchAgentPlist(await safeReadText(join(launchAgentsDir, fileName), ''));
    const label = parsed.label || fileName.replace(/\.plist$/, '');
    const name = label.replace(/^com\.chatserver\./, '');
    const port = parsed.port || 0;
    const hostname = cloudMap.get(port) || '';
    services.push({
      name,
      label,
      kind: name === 'companion' ? 'companion' : (TRIAL_INSTANCE_RE.test(name) ? 'trial' : 'instance'),
      port,
      hostname,
      publicBaseUrl: normalizeBaseUrl(hostname),
      localBaseUrl: port ? `http://127.0.0.1:${port}` : '',
      instanceRoot: parsed.instanceRoot,
      logPath: parsed.standardOutPath,
      errorLogPath: parsed.standardErrorPath,
    });
  }

  return services.sort((left, right) => naturalCompare(left.name, right.name));
}

async function discoverTrialInstances({ homeDir = HOME, services = [] } = {}) {
  const configDir = join(homeDir, '.config', 'remotelab');
  const registry = await safeReadJson(join(configDir, 'guest-instances.json'), []);
  const byName = new Map();
  const cloudMap = await buildCloudflaredPortMap(homeDir);

  for (const service of services) {
    if (!TRIAL_INSTANCE_RE.test(service.name)) continue;
    byName.set(service.name, {
      name: service.name,
      label: service.label,
      port: service.port,
      hostname: service.hostname || cloudMap.get(service.port) || '',
      publicBaseUrl: service.publicBaseUrl || normalizeBaseUrl(service.hostname || cloudMap.get(service.port) || ''),
      localBaseUrl: service.localBaseUrl || (service.port ? `http://127.0.0.1:${service.port}` : ''),
      instanceRoot: service.instanceRoot,
      configDir: service.instanceRoot ? join(service.instanceRoot, 'config') : '',
      memoryDir: service.instanceRoot ? join(service.instanceRoot, 'memory') : '',
      logPath: service.logPath,
      errorLogPath: service.errorLogPath,
      source: 'launchagent',
    });
  }

  for (const entry of Array.isArray(registry) ? registry : []) {
    const name = trimString(entry?.name);
    if (!TRIAL_INSTANCE_RE.test(name)) continue;
    const existing = byName.get(name) || {};
    const port = Number.parseInt(`${entry?.port || existing.port || 0}`, 10) || 0;
    const hostname = trimString(entry?.hostname) || existing.hostname || cloudMap.get(port) || '';
    byName.set(name, {
      ...existing,
      ...entry,
      name,
      port,
      hostname,
      publicBaseUrl: trimString(entry?.publicBaseUrl) || existing.publicBaseUrl || normalizeBaseUrl(hostname),
      localBaseUrl: trimString(entry?.localBaseUrl) || existing.localBaseUrl || (port ? `http://127.0.0.1:${port}` : ''),
      source: 'registry',
    });
  }

  const instancesRoot = join(homeDir, '.remotelab', 'instances');
  if (await pathExists(instancesRoot)) {
    for (const name of (await readdir(instancesRoot)).filter((entry) => TRIAL_INSTANCE_RE.test(entry))) {
      const existing = byName.get(name) || { name };
      const instanceRoot = existing.instanceRoot || join(instancesRoot, name);
      const port = Number.parseInt(`${existing.port || 0}`, 10) || 0;
      const hostname = trimString(existing.hostname) || cloudMap.get(port) || '';
      byName.set(name, {
        ...existing,
        name,
        instanceRoot,
        configDir: existing.configDir || join(instanceRoot, 'config'),
        memoryDir: existing.memoryDir || join(instanceRoot, 'memory'),
        hostname,
        publicBaseUrl: existing.publicBaseUrl || normalizeBaseUrl(hostname),
        localBaseUrl: existing.localBaseUrl || (port ? `http://127.0.0.1:${port}` : ''),
      });
    }
  }

  return [...byName.values()].sort((left, right) => naturalCompare(left.name, right.name));
}

async function readCommandOutput(command, args = []) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return String(result.stdout || '').trim();
  } catch (error) {
    return trimString(error?.stdout || '');
  }
}

async function readListeningPid(port) {
  const output = await readCommandOutput('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  const line = trimString(output).split(/\r?\n/).find(Boolean) || '';
  const pid = Number.parseInt(line, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

async function readProcessSnapshot(pid) {
  if (!pid) return null;
  const output = await readCommandOutput('ps', ['-p', String(pid), '-o', 'pid,%cpu,%mem,rss,etime,command=']);
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const row = lines[lines.length - 1] || '';
  const match = row.match(/^(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)\s+(\S+)\s+([\s\S]+)$/);
  if (!match) return null;
  return {
    pid: Number.parseInt(match[1], 10),
    cpuPercent: Number.parseFloat(match[2]),
    memPercent: Number.parseFloat(match[3]),
    rssBytes: Number.parseInt(match[4], 10) * 1024,
    elapsed: match[5],
    command: match[6],
  };
}

async function collectChatServerProcesses({ services = [] } = {}) {
  const records = [];
  for (const service of services) {
    const pid = service.port ? await readListeningPid(service.port) : 0;
    const process = await readProcessSnapshot(pid);
    records.push({
      ...service,
      pid: process?.pid || 0,
      cpuPercent: process?.cpuPercent ?? 0,
      memPercent: process?.memPercent ?? 0,
      rssBytes: process?.rssBytes ?? 0,
      elapsed: process?.elapsed || '',
      command: process?.command || '',
      listening: !!pid,
    });
  }
  const running = records.filter((record) => record.listening);
  return {
    chatServers: records,
    totalCount: records.length,
    runningCount: running.length,
    totalRssBytes: running.reduce((sum, record) => sum + (record.rssBytes || 0), 0),
  };
}

function buildEmptyServiceSnapshot(services = []) {
  const records = services.map((service) => ({
    ...service,
    pid: 0,
    cpuPercent: 0,
    memPercent: 0,
    rssBytes: 0,
    elapsed: '',
    command: '',
    listening: false,
  }));
  return {
    chatServers: records,
    totalCount: records.length,
    runningCount: 0,
    totalRssBytes: 0,
  };
}

function parseTopSnapshot(output) {
  const loadMatch = output.match(/Load Avg:\s*([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)/);
  const cpuMatch = output.match(/CPU usage:\s*([0-9.]+)% user,\s*([0-9.]+)% sys,\s*([0-9.]+)% idle/i);
  const memMatch = output.match(/PhysMem:\s*([^\n]+)/);
  return {
    loadAvg: {
      one: Number.parseFloat(loadMatch?.[1] || '0') || 0,
      five: Number.parseFloat(loadMatch?.[2] || '0') || 0,
      fifteen: Number.parseFloat(loadMatch?.[3] || '0') || 0,
    },
    cpuUserPercent: Number.parseFloat(cpuMatch?.[1] || '0') || 0,
    cpuSysPercent: Number.parseFloat(cpuMatch?.[2] || '0') || 0,
    cpuIdlePercent: Number.parseFloat(cpuMatch?.[3] || '0') || 0,
    physMemLine: trimString(memMatch?.[1] || ''),
  };
}

function parseMemoryPressure(output) {
  const freeMatch = output.match(/System-wide memory free percentage:\s*(\d+)%/i);
  const swapinsMatch = output.match(/Swapins:\s*(\d+)/i);
  const swapoutsMatch = output.match(/Swapouts:\s*(\d+)/i);
  return {
    memoryPressureFreePercent: Number.parseInt(freeMatch?.[1] || '', 10),
    swapins: Number.parseInt(swapinsMatch?.[1] || '', 10) || 0,
    swapouts: Number.parseInt(swapoutsMatch?.[1] || '', 10) || 0,
  };
}

function parseDfSnapshot(output, mountPath) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const row = lines[lines.length - 1] || '';
  const parts = row.split(/\s+/);
  if (parts.length < 6) {
    return {
      path: mountPath,
      totalBytes: 0,
      usedBytes: 0,
      availableBytes: 0,
      capacityPercent: 0,
    };
  }
  return {
    path: mountPath,
    totalBytes: (Number.parseInt(parts[1], 10) || 0) * 1024,
    usedBytes: (Number.parseInt(parts[2], 10) || 0) * 1024,
    availableBytes: (Number.parseInt(parts[3], 10) || 0) * 1024,
    capacityPercent: Number.parseInt(String(parts[4] || '').replace('%', ''), 10) || 0,
  };
}

function classifyCpuPressure({ cpuCount = 1, cpuIdlePercent = 0, loadAvgOne = 0 }) {
  const normalizedLoad = cpuCount > 0 ? loadAvgOne / cpuCount : loadAvgOne;
  if (cpuIdlePercent <= 20 || normalizedLoad >= 0.9) return 'high';
  if (cpuIdlePercent <= 50 || normalizedLoad >= 0.5) return 'medium';
  return 'low';
}

function classifyMemoryPressure({ memoryPressureFreePercent = null, freeMemoryBytes = 0, totalMemoryBytes = 0, swapouts = 0 }) {
  const freePercent = Number.isFinite(memoryPressureFreePercent)
    ? memoryPressureFreePercent
    : (totalMemoryBytes > 0 ? (freeMemoryBytes / totalMemoryBytes) * 100 : 0);
  if (freePercent <= 15 || swapouts > 0) return 'high';
  if (freePercent <= 35) return 'medium';
  return 'low';
}

function classifyDiskPressure({ availableBytes = 0, capacityPercent = 0 }) {
  if (capacityPercent >= 90 || availableBytes <= 20 * GiB) return 'high';
  if (capacityPercent >= 75 || availableBytes <= 50 * GiB) return 'medium';
  return 'low';
}

function maxPressure(...levels) {
  const weight = { low: 0, medium: 1, high: 2 };
  return levels.reduce((current, level) => (weight[level] > weight[current] ? level : current), 'low');
}

async function collectHostMetrics() {
  const topSnapshot = parseTopSnapshot(await readCommandOutput('top', ['-l', '1']));
  const memoryPressure = process.platform === 'darwin'
    ? parseMemoryPressure(await readCommandOutput('memory_pressure', []))
    : { memoryPressureFreePercent: null, swapins: 0, swapouts: 0 };
  const diskPath = process.platform === 'darwin' ? '/System/Volumes/Data' : '/';
  const disk = parseDfSnapshot(await readCommandOutput('df', ['-k', diskPath]), diskPath);
  const cpuCount = cpus().length || 1;
  const base = {
    generatedAt: new Date().toISOString(),
    hostname: osHostname(),
    platform: process.platform,
    uptimeSeconds: uptime(),
    cpuCount,
    loadAvg: topSnapshot.loadAvg?.one ? topSnapshot.loadAvg : {
      one: loadavg()[0] || 0,
      five: loadavg()[1] || 0,
      fifteen: loadavg()[2] || 0,
    },
    cpuUserPercent: topSnapshot.cpuUserPercent,
    cpuSysPercent: topSnapshot.cpuSysPercent,
    cpuIdlePercent: topSnapshot.cpuIdlePercent,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    usedMemoryBytes: Math.max(totalmem() - freemem(), 0),
    memoryPressureFreePercent: Number.isFinite(memoryPressure.memoryPressureFreePercent)
      ? memoryPressure.memoryPressureFreePercent
      : null,
    swapins: memoryPressure.swapins,
    swapouts: memoryPressure.swapouts,
    diskPath: disk.path,
    diskTotalBytes: disk.totalBytes,
    diskUsedBytes: disk.usedBytes,
    diskAvailableBytes: disk.availableBytes,
    diskCapacityPercent: disk.capacityPercent,
    topPhysMemLine: topSnapshot.physMemLine,
  };
  const cpuStatus = classifyCpuPressure({
    cpuCount: base.cpuCount,
    cpuIdlePercent: base.cpuIdlePercent,
    loadAvgOne: base.loadAvg.one,
  });
  const memoryStatus = classifyMemoryPressure({
    memoryPressureFreePercent: base.memoryPressureFreePercent,
    freeMemoryBytes: base.freeMemoryBytes,
    totalMemoryBytes: base.totalMemoryBytes,
    swapouts: base.swapouts,
  });
  const diskStatus = classifyDiskPressure({
    availableBytes: base.diskAvailableBytes,
    capacityPercent: base.diskCapacityPercent,
  });
  return {
    ...base,
    cpuStatus,
    memoryStatus,
    diskStatus,
    overallPressure: maxPressure(cpuStatus, memoryStatus, diskStatus),
  };
}

function toIsoOrEmpty(value) {
  const parsed = Date.parse(trimString(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function isTimestampInWindow(value, window) {
  const parsed = Date.parse(trimString(value));
  return Number.isFinite(parsed) && parsed >= window.startMs && parsed <= window.endMs;
}

function parseSessionIdFromPathname(pathname) {
  const match = /^\/api\/sessions\/([^/]+)/.exec(trimString(pathname));
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

function countSessionWindowMetrics(sessions, window) {
  let total = 0;
  let createdInWindow = 0;
  let updatedInWindow = 0;
  let latestSessionAt = '';
  for (const session of Array.isArray(sessions) ? sessions : []) {
    total += 1;
    const createdAt = toIsoOrEmpty(session?.createdAt || session?.created);
    const updatedAt = toIsoOrEmpty(session?.updatedAt || session?.lastActivityAt || session?.createdAt || session?.created);
    const createdMs = createdAt ? Date.parse(createdAt) : NaN;
    const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
    if (Number.isFinite(createdMs) && createdMs >= window.startMs && createdMs <= window.endMs) {
      createdInWindow += 1;
    }
    if (Number.isFinite(updatedMs) && updatedMs >= window.startMs && updatedMs <= window.endMs) {
      updatedInWindow += 1;
    }
    const candidate = updatedAt || createdAt;
    if (candidate && (!latestSessionAt || Date.parse(candidate) > Date.parse(latestSessionAt))) {
      latestSessionAt = candidate;
    }
  }
  return {
    sessionCount: total,
    sessionsCreatedInWindow: createdInWindow,
    sessionsUpdatedInWindow: updatedInWindow,
    latestSessionAt,
  };
}

async function summarizeSessionHistories(configDir, sessions, window) {
  const details = [];
  let totalMessages = 0;
  let totalUserMessages = 0;
  let totalAssistantMessages = 0;
  const waitingUserSessionNames = [];
  const highPriorityWaitingSessionNames = [];

  for (const session of Array.isArray(sessions) ? sessions : []) {
    const sessionId = trimString(session?.id);
    const createdAt = toIsoOrEmpty(session?.createdAt || session?.created);
    const updatedAt = toIsoOrEmpty(session?.updatedAt || session?.lastActivityAt || session?.createdAt || session?.created);
    const meta = sessionId
      ? await safeReadJson(join(configDir, 'chat-history', sessionId, 'meta.json'), {})
      : {};
    const counts = meta?.counts || {};
    const userMessageCount = Number(counts.message_user || 0);
    const assistantMessageCount = Number(counts.message_assistant || 0);
    const messageCount = userMessageCount + assistantMessageCount;
    const lastEventAt = Number.isFinite(meta?.lastEventAt)
      ? new Date(meta.lastEventAt).toISOString()
      : toIsoOrEmpty(meta?.lastEventAt);
    const workflowState = trimString(session?.workflowState).toLowerCase();
    const workflowPriority = trimString(session?.workflowPriority).toLowerCase();
    const inWindow = isTimestampInWindow(createdAt, window)
      || isTimestampInWindow(updatedAt, window)
      || isTimestampInWindow(lastEventAt, window);
    const name = trimString(session?.name) || sessionId || 'untitled session';
    const detail = {
      id: sessionId,
      name,
      createdAt,
      updatedAt,
      lastEventAt,
      workflowState,
      workflowPriority,
      userMessageCount,
      assistantMessageCount,
      messageCount,
      activityInWindow: inWindow,
    };
    totalMessages += messageCount;
    totalUserMessages += userMessageCount;
    totalAssistantMessages += assistantMessageCount;
    if (workflowState === 'waiting_user') {
      waitingUserSessionNames.push(name);
      if (workflowPriority === 'high' || workflowPriority === 'urgent') {
        highPriorityWaitingSessionNames.push(name);
      }
    }
    details.push(detail);
  }

  details.sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0));

  return {
    sessions: details,
    totalMessageCount: totalMessages,
    totalUserMessageCount: totalUserMessages,
    totalAssistantMessageCount: totalAssistantMessages,
    activeSessionCountInWindow: details.filter((session) => session.activityInWindow).length,
    waitingUserSessionCount: waitingUserSessionNames.length,
    highPriorityWaitingSessionCount: highPriorityWaitingSessionNames.length,
    waitingUserSessionNames,
    highPriorityWaitingSessionNames,
  };
}

async function summarizeApiLogs(configDir, window) {
  const apiDir = join(configDir, 'api-logs');
  const result = {
    realApiRequestsInWindow: 0,
    latestRealRequestAt: '',
    latestRealRoute: '',
    sessionCreateRequestsInWindow: 0,
    userMessagesInWindow: 0,
    latestUserMessageAt: '',
    latestUserMessageSessionId: '',
    sessionIdsWithUserMessagesInWindow: [],
  };
  if (!await pathExists(apiDir)) return result;
  const dateStrings = listWindowDates(window);
  const activeMessageSessionIds = new Set();
  for (const dateString of dateStrings) {
    const filePath = join(apiDir, `${dateString}.jsonl`);
    const content = await safeReadText(filePath, '');
    if (!content) continue;
    for (const line of content.split(/\r?\n/)) {
      if (!trimString(line)) continue;
      try {
        const record = JSON.parse(line);
        const ts = Date.parse(record?.ts || '');
        if (!Number.isFinite(ts) || ts < window.startMs || ts > window.endMs) continue;
        const method = trimString(record?.method).toUpperCase();
        const pathname = trimString(record?.pathname);
        const route = trimString(record?.route) || pathname;
        if (method === 'POST' && pathname === '/api/sessions') {
          result.sessionCreateRequestsInWindow += 1;
        }
        if (method === 'POST' && route === 'POST /api/sessions/:sessionId/messages') {
          result.userMessagesInWindow += 1;
          const sessionId = parseSessionIdFromPathname(pathname);
          if (sessionId) activeMessageSessionIds.add(sessionId);
          if (!result.latestUserMessageAt || ts > Date.parse(result.latestUserMessageAt)) {
            result.latestUserMessageAt = new Date(ts).toISOString();
            result.latestUserMessageSessionId = sessionId;
          }
        }
        if (pathname === '/api/build-info' || route === 'GET /api/build-info') continue;
        result.realApiRequestsInWindow += 1;
        if (!result.latestRealRequestAt || ts > Date.parse(result.latestRealRequestAt)) {
          result.latestRealRequestAt = new Date(ts).toISOString();
          result.latestRealRoute = route || pathname;
        }
      } catch {
      }
    }
  }
  result.sessionIdsWithUserMessagesInWindow = [...activeMessageSessionIds];
  return result;
}

function classifyTrialStatus(record) {
  if (record.localReachable === false) return 'stopped';
  if (record.realApiRequestsInWindow > 0 || record.sessionsCreatedInWindow > 0 || record.sessionsUpdatedInWindow > 0) {
    return 'active';
  }
  if (record.sessionCount > 0 || record.latestSessionAt) {
    return 'idle-with-history';
  }
  return 'idle-empty';
}

function probeBuildInfo(baseUrl, timeoutMs = 2000) {
  if (!trimString(baseUrl)) {
    return Promise.resolve({ ok: false, statusCode: 0 });
  }
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/api/build-info', baseUrl);
    } catch {
      resolve({ ok: false, statusCode: 0 });
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method: 'GET' }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode === 200, statusCode: res.statusCode || 0 });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', () => resolve({ ok: false, statusCode: 0 }));
    req.end();
  });
}

function formatNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value);
}

function formatBytesShort(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= GiB) return `${formatNumber(bytes / GiB)} GiB`;
  if (bytes >= MiB) return `${formatNumber(bytes / MiB)} MiB`;
  if (bytes >= 1024) return `${formatNumber(bytes / 1024)} KiB`;
  return `${formatNumber(bytes, 0)} B`;
}

function summarizeTrialFleet(trials) {
  const active = [];
  const idle = [];
  const stopped = [];
  const neverUsed = [];
  for (const trial of trials) {
    if (trial.status === 'active') active.push(trial);
    else if (trial.status === 'stopped') stopped.push(trial);
    else idle.push(trial);
    if (trial.sessionCount === 0 && trial.realApiRequestsInWindow === 0) neverUsed.push(trial);
  }
  return {
    totalCount: trials.length,
    runningCount: trials.filter((trial) => trial.localReachable).length,
    activeInWindowCount: active.length,
    idleCount: idle.length,
    stoppedCount: stopped.length,
    neverUsedCount: neverUsed.length,
    activeNames: active.map((trial) => trial.name),
    idleNames: idle.map((trial) => trial.name),
    stoppedNames: stopped.map((trial) => trial.name),
    candidatePauseNames: idle.filter((trial) => trial.localReachable).map((trial) => trial.name),
  };
}

function summarizeProductFleet(trials) {
  const activeTrialNames = [];
  const waitingSessions = [];
  const highPriorityWaitingSessions = [];
  const browseOnlyTrialNames = [];
  let totalUserMessagesInWindow = 0;
  let totalSessionsCreatedInWindow = 0;
  let totalEngagedSessionsInWindow = 0;

  for (const trial of trials) {
    totalUserMessagesInWindow += Number(trial.userMessagesInWindow || 0);
    totalSessionsCreatedInWindow += Number(trial.sessionsCreatedInWindow || 0);
    totalEngagedSessionsInWindow += Number(trial.engagedSessionCountInWindow || 0);
    if ((trial.userMessagesInWindow || 0) > 0 || (trial.sessionsCreatedInWindow || 0) > 0) {
      activeTrialNames.push(trial.name);
    }
    if ((trial.realApiRequestsInWindow || 0) > 0 && (trial.userMessagesInWindow || 0) === 0 && (trial.sessionsCreatedInWindow || 0) === 0) {
      browseOnlyTrialNames.push(trial.name);
    }
    for (const sessionName of trial.waitingUserSessionNames || []) {
      waitingSessions.push(`${trial.name} · ${sessionName}`);
    }
    for (const sessionName of trial.highPriorityWaitingSessionNames || []) {
      highPriorityWaitingSessions.push(`${trial.name} · ${sessionName}`);
    }
  }

  const hottestTrialsByMessages = [...trials]
    .filter((trial) => (trial.userMessagesInWindow || 0) > 0)
    .sort((left, right) => right.userMessagesInWindow - left.userMessagesInWindow)
    .slice(0, 3)
    .map((trial) => ({
      name: trial.name,
      userMessagesInWindow: trial.userMessagesInWindow,
      sessionsCreatedInWindow: trial.sessionsCreatedInWindow,
    }));

  return {
    activeTrialCountInWindow: activeTrialNames.length,
    activeTrialNames,
    totalUserMessagesInWindow,
    totalSessionsCreatedInWindow,
    totalEngagedSessionsInWindow,
    waitingSessions,
    highPriorityWaitingSessions,
    browseOnlyTrialNames,
    hottestTrialsByMessages,
  };
}

export async function collectLocalOpsReport({
  homeDir = HOME,
  date,
  days = 1,
  nowMs = Date.now(),
  hostMetrics = null,
  chatServerProcesses = null,
  instanceStatusProbe = null,
  includeHostMetrics = true,
  includeServiceProcesses = true,
  reachabilityMode = 'full',
} = {}) {
  const window = resolveOpsWindow({ date, days, nowMs });
  const services = await discoverChatServerServices({ homeDir });
  const serviceSnapshot = chatServerProcesses
    || (includeServiceProcesses
      ? await collectChatServerProcesses({ services })
      : buildEmptyServiceSnapshot(services));
  const processByPort = new Map(serviceSnapshot.chatServers.map((record) => [record.port, record]));
  const trials = await discoverTrialInstances({ homeDir, services });
  const probe = instanceStatusProbe || (async (instance) => {
    if (reachabilityMode === 'none') {
      return {
        localReachable: null,
        publicReachable: null,
      };
    }
    if (reachabilityMode === 'local') {
      const local = await probeBuildInfo(instance.localBaseUrl, 1500);
      return {
        localReachable: local.ok,
        publicReachable: null,
      };
    }
    const [local, publicStatus] = await Promise.all([
      probeBuildInfo(instance.localBaseUrl, 1500),
      instance.publicBaseUrl ? probeBuildInfo(instance.publicBaseUrl, 4000) : Promise.resolve({ ok: false, statusCode: 0 }),
    ]);
    return {
      localReachable: local.ok,
      publicReachable: instance.publicBaseUrl ? publicStatus.ok : null,
    };
  });

  const trialDetails = await Promise.all(trials.map(async (instance) => {
    const process = processByPort.get(instance.port) || null;
    const sessions = await safeReadJson(join(instance.configDir || '', 'chat-sessions.json'), []);
    const sessionSummary = countSessionWindowMetrics(sessions, window);
    const historySummary = await summarizeSessionHistories(instance.configDir || '', sessions, window);
    const apiSummary = await summarizeApiLogs(instance.configDir || '', window);
    const reachability = await probe(instance);
    const sessionIdToName = new Map((historySummary.sessions || []).map((session) => [session.id, session.name]));
    const engagedSessionNames = (apiSummary.sessionIdsWithUserMessagesInWindow || [])
      .map((sessionId) => sessionIdToName.get(sessionId) || sessionId)
      .filter(Boolean);
    const enriched = {
      ...instance,
      ...sessionSummary,
      ...historySummary,
      ...apiSummary,
      engagedSessionCountInWindow: engagedSessionNames.length,
      engagedSessionNames,
      localReachable: reachability.localReachable,
      publicReachable: reachability.publicReachable,
      pid: process?.pid || 0,
      cpuPercent: process?.cpuPercent ?? 0,
      memPercent: process?.memPercent ?? 0,
      rssBytes: process?.rssBytes ?? 0,
      elapsed: process?.elapsed || '',
      command: process?.command || '',
    };
    return {
      ...enriched,
      status: classifyTrialStatus(enriched),
    };
  }));

  trialDetails.sort((left, right) => naturalCompare(left.name, right.name));
  const machine = hostMetrics || (includeHostMetrics ? await collectHostMetrics() : EMPTY_HOST_METRICS);
  const trialSummary = summarizeTrialFleet(trialDetails);
  const productSummary = summarizeProductFleet(trialDetails);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    window,
    machine,
    services: serviceSnapshot,
    trials: trialDetails,
    trialSummary,
    productSummary,
  };
}

export function renderLocalOpsSummary(report) {
  const { machine, services, trialSummary, productSummary } = report;
  const hottestTrials = (productSummary?.hottestTrialsByMessages || [])
    .map((trial) => `${trial.name} (${trial.userMessagesInWindow} msg, ${trial.sessionsCreatedInWindow} new)`);
  const lines = [
    `Local ops sidecar for ${report.window.label}: product activity ${productSummary.activeTrialCountInWindow}/${trialSummary.totalCount} trial users active, ${productSummary.totalUserMessagesInWindow} user messages, ${productSummary.totalSessionsCreatedInWindow} new sessions, ${productSummary.totalEngagedSessionsInWindow} engaged sessions${productSummary.highPriorityWaitingSessions.length ? `; follow-up needed: ${productSummary.highPriorityWaitingSessions.join(', ')}` : ''}.`,
    `- Host pressure ${machine.overallPressure}; load ${formatNumber(machine.loadAvg.one, 2)}/${formatNumber(machine.loadAvg.five, 2)}/${formatNumber(machine.loadAvg.fifteen, 2)} on ${machine.cpuCount} CPUs${machine.cpuIdlePercent ? `, ${formatNumber(machine.cpuIdlePercent, 0)}% idle snapshot` : ''}; memory ${machine.memoryStatus}${machine.memoryPressureFreePercent !== null ? ` (${formatNumber(machine.memoryPressureFreePercent, 0)}% free by memory_pressure` : ''}${machine.swapouts ? `, swapouts ${formatNumber(machine.swapouts, 0)})` : machine.memoryPressureFreePercent !== null ? ', no swapouts)' : ''}; disk ${formatNumber(machine.diskCapacityPercent, 0)}% used with ${formatBytesShort(machine.diskAvailableBytes)} free.`,
    `- Chat servers running: ${services.runningCount}/${services.totalCount}; total RSS ${formatBytesShort(services.totalRssBytes)}.`,
    `- Trial services active in window: ${trialSummary.activeInWindowCount}/${trialSummary.totalCount}; idle: ${trialSummary.idleNames.join(', ') || 'none'}; stopped: ${trialSummary.stoppedNames.join(', ') || 'none'}.`,
  ];
  if (hottestTrials.length > 0) {
    lines.push(`- Most active trials: ${hottestTrials.join(', ')}.`);
  }
  if (productSummary.browseOnlyTrialNames.length > 0) {
    lines.push(`- Browse-only trials: ${productSummary.browseOnlyTrialNames.join(', ')}.`);
  }
  return lines.join('\n');
}

export function renderLocalOpsMarkdown(report) {
  const lines = [
    `# Local Ops Sidecar — ${report.window.label}`,
    '',
    `Generated at ${report.generatedAt}.`,
    '',
    '## Product Signals',
    `- Trial users active in window: **${report.productSummary.activeTrialCountInWindow}/${report.trialSummary.totalCount}**`,
    `- User messages in window: **${formatNumber(report.productSummary.totalUserMessagesInWindow, 0)}**`,
    `- New sessions in window: **${formatNumber(report.productSummary.totalSessionsCreatedInWindow, 0)}**`,
    `- Engaged sessions in window: **${formatNumber(report.productSummary.totalEngagedSessionsInWindow, 0)}**`,
    `- High-priority follow-up: ${report.productSummary.highPriorityWaitingSessions.join(', ') || 'none'}`,
    `- Browse-only trials: ${report.productSummary.browseOnlyTrialNames.join(', ') || 'none'}`,
    '',
    '## Host Pressure',
    `- Overall pressure: **${report.machine.overallPressure}**`,
    `- CPU: load ${formatNumber(report.machine.loadAvg.one, 2)}/${formatNumber(report.machine.loadAvg.five, 2)}/${formatNumber(report.machine.loadAvg.fifteen, 2)} on ${report.machine.cpuCount} CPUs${report.machine.cpuIdlePercent ? `, ${formatNumber(report.machine.cpuIdlePercent, 1)}% idle snapshot` : ''}`,
    `- Memory: ${formatBytesShort(report.machine.usedMemoryBytes)} used / ${formatBytesShort(report.machine.totalMemoryBytes)} total; free ${formatBytesShort(report.machine.freeMemoryBytes)}${report.machine.memoryPressureFreePercent !== null ? `; memory_pressure free ${formatNumber(report.machine.memoryPressureFreePercent, 0)}%` : ''}${report.machine.swapouts ? `; swapouts ${formatNumber(report.machine.swapouts, 0)}` : '; no swapouts'}`,
    `- Disk: ${report.machine.diskPath} — ${formatBytesShort(report.machine.diskUsedBytes)} used / ${formatBytesShort(report.machine.diskTotalBytes)} total; ${formatBytesShort(report.machine.diskAvailableBytes)} free (${formatNumber(report.machine.diskCapacityPercent, 0)}% used)`,
    '',
    '## Chat Servers',
    `- Running: ${report.services.runningCount}/${report.services.totalCount}`,
    `- Total RSS: ${formatBytesShort(report.services.totalRssBytes)}`,
  ];

  for (const service of report.services.chatServers.filter((record) => record.listening)) {
    lines.push(`- ${service.name} — :${service.port} — pid ${service.pid} — ${formatBytesShort(service.rssBytes)} RSS — ${formatNumber(service.cpuPercent, 1)}% CPU`);
  }

  lines.push('', '## Trial Services');
  if (report.trials.length === 0) {
    lines.push('- No trial services discovered.');
  } else {
    for (const trial of report.trials) {
      const publicStatus = trial.publicReachable === null
        ? 'local-only'
        : (trial.publicReachable ? 'public reachable' : 'public not reachable');
      const latestBits = [];
      if (trial.latestSessionAt) latestBits.push(`latest session ${trial.latestSessionAt}`);
      if (trial.latestRealRequestAt) latestBits.push(`latest real request ${trial.latestRealRequestAt} (${trial.latestRealRoute || 'route unknown'})`);
      const productBits = [
        `${trial.sessionCount} total sessions`,
        `${trial.sessionsCreatedInWindow} new`,
        `${trial.sessionsUpdatedInWindow} updated`,
        `${trial.userMessagesInWindow} user messages in window`,
        `${trial.engagedSessionCountInWindow} engaged sessions in window`,
        `${trial.totalUserMessageCount} total user messages`,
      ];
      if (trial.highPriorityWaitingSessionNames.length > 0) {
        productBits.push(`high-priority waiting ${trial.highPriorityWaitingSessionNames.join(', ')}`);
      } else if (trial.waitingUserSessionNames.length > 0) {
        productBits.push(`waiting ${trial.waitingUserSessionNames.join(', ')}`);
      }
      lines.push(`- ${trial.name} — ${trial.status} — :${trial.port || '?'} — ${trial.localReachable ? 'running' : 'stopped'} / ${publicStatus} — ${productBits.join(', ')}, ${trial.realApiRequestsInWindow} real API requests in window${latestBits.length ? ` — ${latestBits.join('; ')}` : ''}`);
    }
  }

  lines.push('', '## Attention');
  if (report.productSummary.highPriorityWaitingSessions.length > 0) {
    lines.push(`- Product follow-up likely needed: ${report.productSummary.highPriorityWaitingSessions.join(', ')}.`);
  } else if (report.productSummary.totalUserMessagesInWindow > 0) {
    lines.push('- Trial usage is present and does not show an obvious urgent follow-up queue from workflow state.');
  } else {
    lines.push('- No new trial user messages landed in this review window.');
  }
  if (report.productSummary.browseOnlyTrialNames.length > 0) {
    lines.push(`- Some users are browsing without sending messages yet: ${report.productSummary.browseOnlyTrialNames.join(', ')}.`);
  }
  if (report.machine.overallPressure === 'low') {
    lines.push('- No immediate machine-capacity risk is visible from this snapshot.');
  } else {
    lines.push('- Machine pressure is not low; inspect the host snapshot before adding more long-lived services.');
  }
  if (report.trialSummary.candidatePauseNames.length > 0) {
    lines.push(`- Idle running trials worth reviewing: ${report.trialSummary.candidatePauseNames.join(', ')}.`);
  } else {
    lines.push('- No obviously idle running trial instance stands out from this review window.');
  }

  return lines.join('\n');
}

function reportBaseName(window) {
  return `local-ops-${window.endDate}-d${window.days}`;
}

export async function generateLocalOpsSidecar({
  homeDir = HOME,
  outputDir,
  date,
  days = 1,
  nowMs = Date.now(),
  hostMetrics = null,
  chatServerProcesses = null,
  instanceStatusProbe = null,
} = {}) {
  const effectiveOutputDir = outputDir || join(homeDir, '.remotelab', 'reports', 'local-ops');
  const report = await collectLocalOpsReport({
    homeDir,
    date,
    days,
    nowMs,
    hostMetrics,
    chatServerProcesses,
    instanceStatusProbe,
  });

  if (!await pathExists(effectiveOutputDir)) {
    await mkdir(effectiveOutputDir, { recursive: true });
  }

  const baseName = reportBaseName(report.window);
  const markdownPath = join(effectiveOutputDir, `${baseName}.md`);
  const jsonPath = join(effectiveOutputDir, `${baseName}.json`);
  const markdown = renderLocalOpsMarkdown(report);
  const summary = renderLocalOpsSummary(report);

  await writeFile(markdownPath, `${markdown}\n`, 'utf8');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return {
    report,
    summary,
    markdownPath,
    jsonPath,
  };
}
