#!/usr/bin/env node
// Standalone admin dashboard for RemoteLab guest instances.
// Usage: node scripts/instance-admin.mjs [--port PORT]
// Default: http://127.0.0.1:7689

import { createServer } from 'http';
import { execFile } from 'child_process';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { promisify } from 'util';
import { randomBytes, timingSafeEqual, scrypt } from 'crypto';
import { fullPath } from '../lib/user-shell-env.mjs';
import { parseCloudflaredIngress } from '../lib/cloudflared-config.mjs';
import { buildInstanceVersionState, buildStateNeedsAttention, normalizeBuildSummary } from '../lib/build-sync.mjs';
import { classifyUsageOperation, queryUsageLedger } from '../chat/usage-ledger.mjs';
import {
  attachInstanceAccess,
  loadInstanceAccessDefaults,
  normalizeBaseUrl,
  resolveBridgeBaseUrl,
} from '../lib/instance-access.mjs';

const scryptAsync = promisify(scrypt);
const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_PATH = join(PROJECT_ROOT, 'cli.js');
const TEMPLATE_PATH = join(PROJECT_ROOT, 'templates', 'instance-admin.html');
const LOGIN_TEMPLATE_PATH = join(PROJECT_ROOT, 'templates', 'admin-login.html');
const HOME = homedir();
const LAUNCH_AGENTS_DIR = join(HOME, 'Library', 'LaunchAgents');
const OWNER_LAUNCH_AGENT_PATH = join(LAUNCH_AGENTS_DIR, 'com.chatserver.claude.plist');
const OWNER_AUTH_FILE = join(HOME, '.config', 'remotelab', 'auth.json');
const OWNER_CONFIG_DIR = join(HOME, '.config', 'remotelab');
const OWNER_MEMORY_DIR = join(HOME, '.remotelab', 'memory');
const GUEST_DEFAULTS_FILE = join(HOME, '.config', 'remotelab', 'guest-instance-defaults.json');
const GUEST_REGISTRY_FILE = join(HOME, '.config', 'remotelab', 'guest-instances.json');
const USER_BINDINGS_FILE = join(HOME, '.config', 'remotelab', 'user-instance-bindings.json');
const USER_LEDGER_FILE = join(HOME, '.remotelab', 'memory', 'tasks', 'remotelab-user-relationship-ledger.md');
const USER_EVENT_LOG_FILE = join(HOME, '.remotelab', 'memory', 'tasks', 'remotelab-user-event-log.md');
const TRIAL_OCCUPANCY_LEDGER_FILE = join(HOME, '.remotelab', 'memory', 'tasks', 'remotelab-trial-user-ledger.md');
const SESSION_COOKIE = 'admin_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_USAGE_WINDOW_DAYS = 30;
const DEFAULT_USAGE_BREAKDOWN_TOP = 5;
const DASHBOARD_CACHE_TTL_MS = 30 * 1000;
const WORKBENCH_CACHE_TTL_MS = 30 * 1000;
const BILLING_CACHE_TTL_MS = 30 * 1000;
const ENGAGEMENT_CACHE_TTL_MS = 2 * 60 * 1000;

const PORT = (() => {
  const idx = process.argv.indexOf('--port');
  return parseInt(idx >= 0 ? process.argv[idx + 1] : process.env.INSTANCE_ADMIN_PORT || '7689', 10);
})();
const HOST = process.env.INSTANCE_ADMIN_HOST || '127.0.0.1';

// --- Auth ---

const sessions = new Map(); // sessionToken → { expiry }

async function loadAuthConfig() {
  try {
    return JSON.parse(await readFile(OWNER_AUTH_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function verifyToken(inputToken) {
  if (!inputToken) return false;
  const auth = await loadAuthConfig();
  if (!auth.token) return false;
  const storedBuf = Buffer.from(auth.token, 'hex');
  const inputBuf = Buffer.from(inputToken, 'hex');
  if (storedBuf.length !== inputBuf.length) return false;
  return timingSafeEqual(storedBuf, inputBuf);
}

async function verifyPassword(username, password) {
  if (!username || !password) return false;
  const auth = await loadAuthConfig();
  if (!auth.username || !auth.passwordHash) return false;
  if (auth.username !== username) return false;
  const parts = auth.passwordHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const storedHash = Buffer.from(hashHex, 'hex');
  try {
    const inputHash = await scryptAsync(password, salt, 32, {
      N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10),
    });
    return timingSafeEqual(storedHash, inputHash);
  } catch {
    return false;
  }
}

function createSession() {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { expiry: Date.now() + SESSION_MAX_AGE });
  return token;
}

function getValidSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiry) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  }
  return cookies;
}

function isLocalRequest(req) {
  if (req.headers['cf-connecting-ip']) return false;
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function checkAuth(req) {
  if (isLocalRequest(req)) return true;
  const cookies = parseCookies(req.headers['cookie'] || '');
  return !!getValidSession(cookies[SESSION_COOKIE]);
}

function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_MAX_AGE / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function requestFlag(req, key) {
  try {
    const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    const normalized = trimString(requestUrl.searchParams.get(key)).toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  } catch {
    return false;
  }
}

// --- Helpers ---

async function cli(args, timeout = 120_000) {
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, PATH: fullPath },
  });
  return JSON.parse(stdout.trim());
}

async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new Error('Body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return JSON.parse(text);
}

function json(res, data, status = 200) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sanitize(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isCacheFresh(cache, ttlMs) {
  return !!cache?.data && cache.updatedAt > 0 && (Date.now() - cache.updatedAt) < ttlMs;
}

function cacheIso(updatedAt) {
  return new Date(updatedAt || Date.now()).toISOString();
}

function resetCacheState(cache, extras = {}) {
  cache.data = null;
  cache.updatedAt = 0;
  cache.refreshPromise = null;
  Object.assign(cache, extras);
}

function invalidateDerivedCaches() {
  resetCacheState(workbenchCache, {
    dashboardUpdatedAt: 0,
    refreshDashboardUpdatedAt: 0,
  });
  resetCacheState(billingCache, {
    dashboardUpdatedAt: 0,
    workbenchUpdatedAt: 0,
    refreshDashboardUpdatedAt: 0,
    refreshWorkbenchUpdatedAt: 0,
  });
}

function invalidateAdminCaches() {
  resetCacheState(dashboardCache, {
    hasChecks: false,
    refreshIncludesChecks: false,
  });
  invalidateDerivedCaches();
  resetCacheState(engagementCache);
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractPlistBlock(content, key, tag) {
  const match = String(content || '').match(new RegExp(`<key>${escapeRegex(key)}</key>\\s*<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1] || '';
}

function extractPlistString(content, key) {
  return decodeXmlEntities(extractPlistBlock(content, key, 'string'));
}

function extractPlistDictStrings(content, key) {
  const block = extractPlistBlock(content, key, 'dict');
  const entries = Array.from(block.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g));
  return Object.fromEntries(entries.map(([, rawKey, rawValue]) => [
    decodeXmlEntities(rawKey || ''),
    decodeXmlEntities(rawValue || ''),
  ]));
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

function countCollection(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function normalizeSessionRecords(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry && typeof entry === 'object');
  }
  if (value && Array.isArray(value.sessions)) {
    return value.sessions.filter((entry) => entry && typeof entry === 'object');
  }
  if (value && typeof value === 'object') {
    return Object.values(value).filter((entry) => entry && typeof entry === 'object');
  }
  return [];
}

function compareIsoTimestampsDesc(left, right) {
  return String(right || '').localeCompare(String(left || ''));
}

function resolveInstanceUsageStatus(snapshot = {}, { nowMs = Date.now() } = {}) {
  const sessionCount = Number.parseInt(`${snapshot.sessionCount || 0}`, 10) || 0;
  const authSessionCount = Number.parseInt(`${snapshot.authSessionCount || 0}`, 10) || 0;
  if (sessionCount <= 0) {
    return authSessionCount > 0 ? 'opened' : 'empty';
  }

  const lastSessionMs = Date.parse(snapshot.lastSessionAt || '');
  if (!Number.isFinite(lastSessionMs)) return 'occupied';

  const ageMs = Math.max(0, nowMs - lastSessionMs);
  if (ageMs <= 2 * 24 * 60 * 60 * 1000) return 'active';
  if (ageMs <= 14 * 24 * 60 * 60 * 1000) return 'occupied';
  return 'stale';
}

function resolveInstanceUsageBrief(snapshot = {}, { nowMs = Date.now() } = {}) {
  const status = resolveInstanceUsageStatus(snapshot, { nowMs });
  if (status === 'empty') return 'unused';
  if (status === 'opened') return 'opened, no chat yet';
  if (status === 'active') return 'recent activity';
  if (status === 'occupied') return 'has chat history';
  return 'stale but occupied';
}

async function readJsonFileSafe(filePath, fallbackValue) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

async function readTextFileSafe(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function stripMarkdown(value) {
  return trimString(String(value || '').replace(/`/g, '').replace(/\*\*/g, ''));
}

function normalizeUserKey(value) {
  return stripMarkdown(value).toLowerCase();
}

function parseListValue(value) {
  return stripMarkdown(value)
    .split(',')
    .map((part) => stripMarkdown(part))
    .filter(Boolean)
    .filter((part) => part.toLowerCase() !== 'none');
}

function normalizeLogTimestamp(value) {
  const trimmed = stripMarkdown(value);
  if (!trimmed) return '';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(trimmed)) {
    return `${trimmed.replace(' ', 'T')}:00+08:00`;
  }
  return trimmed;
}

function extractInstanceFromHistory(history) {
  const matches = [...String(history || '').matchAll(/`([^`]+)`/g)].map((match) => stripMarkdown(match[1]));
  return matches.length ? matches[matches.length - 1] : '';
}

function normalizeInstanceUsageKey(value) {
  const key = trimString(value).toLowerCase();
  if (key === 'active') return 'occupied';
  if (key === 'stale') return 'occupied';
  if (key === 'opened') return 'open';
  if (key === 'reserved') return 'reserved';
  return key;
}

function parseRelationshipLedger(markdown = '') {
  const cards = new Map();
  let current = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith('### ')) {
      const name = line.slice(4).trim();
      current = {
        userName: name,
        canonicalName: name,
        aliases: [],
        source: '',
        instanceHistory: '',
        currentStage: '',
        latestSignal: '',
        latestUpdate: '',
        nextFollowUp: '',
        notes: '',
      };
      cards.set(normalizeUserKey(name), current);
      continue;
    }

    if (!current || !line.startsWith('- ')) continue;
    const match = line.slice(2).match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;

    const key = trimString(match[1]).toLowerCase();
    const value = stripMarkdown(match[2]);

    if (key === 'canonical name') current.canonicalName = value || current.userName;
    else if (key === 'aliases') current.aliases = parseListValue(value);
    else if (key === 'source') current.source = value;
    else if (key === 'instance history') current.instanceHistory = value;
    else if (key === 'current stage') current.currentStage = value;
    else if (key === 'latest signal') current.latestSignal = value;
    else if (key === 'latest update') current.latestUpdate = value;
    else if (key === 'next follow-up') current.nextFollowUp = value;
    else if (key === 'notes') current.notes = value;
  }

  return cards;
}

function parseUserEventLog(markdown = '') {
  const events = new Map();
  let current = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const header = line.match(/^- `([^`]+)` `([^`]+)` — user `([^`]+)` — source `([^`]+)` — event `([^`]+)`$/);
    if (header) {
      current = {
        happenedAt: normalizeLogTimestamp(header[1]),
        timezone: stripMarkdown(header[2]),
        userName: stripMarkdown(header[3]),
        source: stripMarkdown(header[4]),
        eventType: stripMarkdown(header[5]),
        instanceName: '',
        summary: '',
        operatorAction: '',
      };
      const key = normalizeUserKey(current.userName);
      if (!events.has(key)) events.set(key, []);
      events.get(key).push(current);
      continue;
    }

    if (!current) continue;

    const instanceMatch = line.match(/^\s+- instance: `([^`]+)`$/);
    if (instanceMatch) {
      current.instanceName = stripMarkdown(instanceMatch[1]);
      continue;
    }

    const summaryMatch = line.match(/^\s+- summary: (.+)$/);
    if (summaryMatch) {
      current.summary = stripMarkdown(summaryMatch[1]);
      continue;
    }

    const operatorMatch = line.match(/^\s+- operator action: (.+)$/);
    if (operatorMatch) {
      current.operatorAction = stripMarkdown(operatorMatch[1]);
    }
  }

  for (const list of events.values()) {
    list.sort((left, right) => new Date(right.happenedAt).getTime() - new Date(left.happenedAt).getTime());
  }

  return events;
}

function parseTrialOccupancyLedger(markdown = '') {
  const entries = new Map();
  let inActiveAssignments = false;
  let current = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith('## ')) {
      inActiveAssignments = line.trim() === '## Active assignments';
      current = null;
      continue;
    }

    if (!inActiveAssignments) continue;

    const header = line.match(/^- `([^`]+)`$/);
    if (header) {
      current = {
        instanceName: stripMarkdown(header[1]),
        userName: '',
        source: '',
        assignedAt: '',
        handoffNote: '',
        status: '',
        recordedFrom: '',
      };
      entries.set(current.instanceName, current);
      continue;
    }

    if (!current) continue;

    const field = line.match(/^\s+- ([^:]+):\s*(.+)$/);
    if (!field) continue;

    const key = trimString(field[1]).toLowerCase();
    const value = stripMarkdown(field[2]);
    if (key === 'user') current.userName = value;
    else if (key === 'source') current.source = value;
    else if (key === 'assigned at') current.assignedAt = value;
    else if (key === 'handoff note') current.handoffNote = value;
    else if (key === 'status') current.status = value;
    else if (key === 'recorded from') current.recordedFrom = value;
  }

  return entries;
}

function deriveOccupancyOverlay(entry) {
  if (!entry) return null;
  const statusText = trimString(entry.status).toLowerCase();
  const isReserved = statusText.includes('reserved');
  return {
    instanceName: trimString(entry.instanceName),
    userName: trimString(entry.userName),
    source: trimString(entry.source),
    assignedAt: trimString(entry.assignedAt),
    handoffNote: trimString(entry.handoffNote),
    status: trimString(entry.status),
    recordedFrom: trimString(entry.recordedFrom),
    kind: isReserved ? 'reserved' : 'assigned',
    usageStatus: isReserved ? 'reserved' : 'active',
  };
}

function applyOccupancyOverlay(instance, entry) {
  const occupancy = deriveOccupancyOverlay(entry);
  if (!occupancy) return instance;

  const usage = { ...(instance.usage || {}) };
  const currentUsageKey = normalizeInstanceUsageKey(usage.usageStatus);

  if (occupancy.kind === 'reserved') {
    usage.usageStatus = 'reserved';
    usage.usageBrief = '已预留，暂不外发';
  } else if (currentUsageKey !== 'occupied') {
    usage.usageStatus = 'active';
    if (currentUsageKey === 'open' || currentUsageKey === 'empty' || !trimString(usage.usageBrief)) {
      usage.usageBrief = '已登记占用，暂不重分配';
    }
  }

  return {
    ...instance,
    occupancy,
    usage,
  };
}

function computeDashboardSummary(instances = [], baseSummary = null) {
  const summary = {
    ...(baseSummary || {}),
    totalCount: instances.length,
    occupiedCount: 0,
    openedCount: 0,
    emptyCount: 0,
    emptyNames: [],
    buildDriftCount: 0,
    publicBuildMismatchCount: 0,
  };

  for (const instance of instances) {
    const buildStatus = trimString(instance?.build?.status);
    if (buildStatus === 'stale_runtime') summary.buildDriftCount += 1;
    if (buildStatus === 'public_mismatch') summary.publicBuildMismatchCount += 1;

    const key = normalizeInstanceUsageKey(instance?.usage?.usageStatus);
    if (key === 'occupied' || key === 'reserved') {
      summary.occupiedCount += 1;
      continue;
    }
    if (key === 'open') {
      summary.openedCount += 1;
      continue;
    }
    summary.emptyCount += 1;
    if (instance?.name) summary.emptyNames.push(instance.name);
  }

  return summary;
}

function classifyInstanceBuild(instance) {
  const build = instance?.build && typeof instance.build === 'object' ? instance.build : null;
  if (!build?.status) {
    return { key: 'unknown', label: '待确认', tone: 'muted', detail: '版本检查尚未完成。' };
  }
  if (build.status === 'stale_runtime') {
    return { key: 'stale_runtime', label: '落后 owner', tone: 'warn', detail: trimString(build.detail) || '本地运行版本落后于 owner 基线。' };
  }
  if (build.status === 'public_mismatch') {
    return { key: 'public_mismatch', label: '公网偏差', tone: 'warn', detail: trimString(build.detail) || '公网入口返回的版本和本地实例不一致。' };
  }
  return { key: 'current', label: trimString(build.label) || '当前版本', tone: 'ok', detail: trimString(build.detail) || '实例版本状态正常。' };
}

function classifyInstanceHealth(instance) {
  if (!instance) {
    return { key: 'unknown', label: '待确认', tone: 'muted', detail: '当前还没有关联实例。' };
  }
  if (instance.localReachable === null && instance.publicReachable === null) {
    return { key: 'unknown', label: '待确认', tone: 'muted', detail: '健康探测尚未完成。' };
  }
  if (instance.localReachable && instance.publicReachable !== false) {
    const buildStatus = classifyInstanceBuild(instance);
    if (buildStateNeedsAttention(instance?.build)) {
      return buildStatus;
    }
    return { key: 'healthy', label: '健康', tone: 'ok', detail: '本地和公网入口都正常。' };
  }
  if (instance.localReachable && instance.publicReachable === false) {
    return { key: 'public_issue', label: '公网异常', tone: 'warn', detail: '本地入口正常，但公网入口不可用。' };
  }
  if (!instance.localReachable && instance.publicReachable) {
    return { key: 'local_issue', label: '本地异常', tone: 'warn', detail: '公网入口正常，但本地探测失败。' };
  }
  return { key: 'offline', label: '离线', tone: 'danger', detail: '本地和公网入口都不可达。' };
}

function deriveLifecycleLabel(user) {
  if (user.needsBinding) return '待绑定';
  const tier = trimString(user.engagementTier);
  if (tier === 'power_user') return '深度用户';
  if (tier === 'active') return '活跃中';
  if (tier === 'onboarding') return '新用户';
  if (tier === 'light') return '轻度使用';
  if (tier === 'cooling') return '趋冷';
  if (tier === 'at_risk') return '需要跟进';
  if (tier === 'churned') return '疑似流失';
  if (tier === 'never_used') return '未启用';
  return stripMarkdown(user.currentStage || '') || '观察中';
}

function hasFeedbackSignal(events = [], ledgerCard = null) {
  if (events.some((event) => trimString(event.eventType).toLowerCase() === 'feedback')) return true;
  const text = `${trimString(ledgerCard?.latestSignal)} ${trimString(ledgerCard?.notes)}`;
  return /反馈|问题|断裂|卡住|无法|不好用|不顺/.test(text);
}

function computeRecentActivityDays(user) {
  if (user.metrics?.daysSinceLastMessage != null) return user.metrics.daysSinceLastMessage;
  if (user.latestEventAt) {
    return Math.round((Date.now() - new Date(user.latestEventAt).getTime()) / 86400000);
  }
  return null;
}

function buildUserWorkbenchPayload({
  dashboardData,
  bindings = [],
  ledgerCards = new Map(),
  eventLog = new Map(),
  engagement = { users: [], actions: [], summary: {} },
} = {}) {
  const instanceMap = new Map((dashboardData?.instances || []).map((instance) => [instance.name, instance]));
  const bindingMap = new Map(bindings.map((binding) => [normalizeUserKey(binding.userName), binding]));
  const engagementMap = new Map((engagement.users || []).map((user) => [normalizeUserKey(user.userName), user]));
  const allKeys = new Set([
    ...bindingMap.keys(),
    ...engagementMap.keys(),
    ...ledgerCards.keys(),
    ...eventLog.keys(),
  ]);

  const users = [...allKeys].map((key) => {
    const binding = bindingMap.get(key) || null;
    const engagementUser = engagementMap.get(key) || null;
    const ledgerCard = ledgerCards.get(key) || null;
    const events = (eventLog.get(key) || []).slice();
    const latestEvent = events[0] || null;
    const instanceName = trimString(binding?.instanceName)
      || trimString(engagementUser?.instanceName)
      || extractInstanceFromHistory(ledgerCard?.instanceHistory)
      || trimString(latestEvent?.instanceName);
    const instance = instanceMap.get(instanceName) || null;
    const latestActivityAt = trimString(engagementUser?.metrics?.latestUserMessageAt) || trimString(latestEvent?.happenedAt);
    const needsBinding = !instanceName;
    const openFeedback = hasFeedbackSignal(events, ledgerCard);
    const followUpAction = engagementUser?.action || null;
    const recentActivityDays = computeRecentActivityDays({
      metrics: engagementUser?.metrics,
      latestEventAt: latestActivityAt,
    });
    const recentlyActive = recentActivityDays != null && recentActivityDays <= 1;
    const lifecycleLabel = deriveLifecycleLabel({
      needsBinding,
      engagementTier: engagementUser?.engagement?.tier,
      currentStage: ledgerCard?.currentStage,
    });
    const latestSummary = trimString(latestEvent?.summary)
      || trimString(ledgerCard?.latestSignal)
      || trimString(followUpAction?.reason)
      || trimString(ledgerCard?.notes);

    const priorityScore = needsBinding
      ? 0
      : openFeedback
        ? 1
        : followUpAction
          ? 2 + (followUpAction.priority || 0)
          : recentlyActive
            ? 9
            : 8;

    return {
      key,
      userName: trimString(binding?.userName) || trimString(engagementUser?.userName) || trimString(ledgerCard?.canonicalName) || trimString(latestEvent?.userName),
      source: trimString(binding?.source) || trimString(engagementUser?.source) || trimString(ledgerCard?.source) || trimString(latestEvent?.source) || 'unknown',
      aliases: binding?.aliases || ledgerCard?.aliases || [],
      bindingStatus: needsBinding ? 'unbound' : 'bound',
      needsBinding,
      instanceName,
      instanceStatus: trimString(engagementUser?.instanceStatus) || trimString(instance?.usage?.usageStatus) || '',
      instanceHealth: classifyInstanceHealth(instance),
      latestEventType: trimString(latestEvent?.eventType) || '',
      latestEventAt: trimString(latestEvent?.happenedAt) || '',
      latestActivityAt,
      latestSummary,
      metrics: engagementUser?.metrics || {
        totalUserMessages: 0,
        sessionCount: 0,
        daysSinceLastMessage: null,
        daysSinceAssigned: null,
        latestUserMessageAt: '',
      },
      engagementTier: trimString(engagementUser?.engagement?.tier) || '',
      engagementLabel: trimString(engagementUser?.engagement?.label) || '',
      lifecycleLabel,
      latestSignal: trimString(ledgerCard?.latestSignal),
      nextFollowUp: trimString(ledgerCard?.nextFollowUp),
      currentStage: trimString(ledgerCard?.currentStage),
      notes: trimString(ledgerCard?.notes) || trimString(binding?.notes),
      openFeedback,
      followUpAction,
      recentlyActive,
      priorityScore,
      quickLinks: instance ? {
        publicAccessUrl: trimString(instance.publicAccessUrl) || trimString(instance.publicBaseUrl),
        bridgeAccessUrl: trimString(instance.bridgeAccessUrl) || trimString(instance.bridgeBaseUrl),
        localAccessUrl: trimString(instance.localAccessUrl) || trimString(instance.localBaseUrl),
        accessChannels: Array.isArray(instance.accessChannels) ? instance.accessChannels : [],
      } : { publicAccessUrl: '', bridgeAccessUrl: '', localAccessUrl: '', accessChannels: [] },
      instanceDetail: instance ? {
        name: instance.name,
        port: instance.port,
        publicBaseUrl: trimString(instance.publicBaseUrl),
        bridgeBaseUrl: trimString(instance.bridgeBaseUrl),
        localBaseUrl: trimString(instance.localBaseUrl),
        publicAccessUrl: trimString(instance.publicAccessUrl),
        bridgeAccessUrl: trimString(instance.bridgeAccessUrl),
        localAccessUrl: trimString(instance.localAccessUrl),
        token: trimString(instance.token),
        accessChannels: Array.isArray(instance.accessChannels) ? instance.accessChannels : [],
      } : null,
      events: events.slice(0, 6),
    };
  }).filter((user) => user.userName);

  users.sort((left, right) => {
    if (left.priorityScore !== right.priorityScore) return left.priorityScore - right.priorityScore;
    const rightTs = new Date(right.latestActivityAt || right.latestEventAt || 0).getTime();
    const leftTs = new Date(left.latestActivityAt || left.latestEventAt || 0).getTime();
    if (rightTs !== leftTs) return rightTs - leftTs;
    return left.userName.localeCompare(right.userName);
  });

  const pendingNeedsBinding = users.filter((user) => user.needsBinding);
  const pendingFeedback = users.filter((user) => !user.needsBinding && user.openFeedback);
  const pendingFollowUp = users.filter((user) => !user.needsBinding && !user.openFeedback && user.followUpAction);
  const pendingRecent = users.filter((user) => !user.needsBinding && !user.openFeedback && !user.followUpAction && user.recentlyActive);

  const attentionCount = (dashboardData?.instances || []).filter((instance) => classifyInstanceHealth(instance).key !== 'healthy').length;
  const summary = {
    totalUsers: users.length,
    boundUsers: users.filter((user) => user.bindingStatus === 'bound').length,
    unboundUsers: users.filter((user) => user.bindingStatus === 'unbound').length,
    feedbackUsers: users.filter((user) => user.openFeedback).length,
    followUpUsers: users.filter((user) => !!user.followUpAction).length,
    activeUsers: users.filter((user) => ['power_user', 'active', 'onboarding'].includes(user.engagementTier)).length,
    atRiskUsers: users.filter((user) => ['at_risk', 'cooling', 'churned', 'never_used'].includes(user.engagementTier)).length,
    activeTodayUsers: users.filter((user) => user.recentlyActive).length,
    instanceAttentionCount: attentionCount,
  };

  return {
    summary,
    pending: {
      summary: {
        needsBindingCount: pendingNeedsBinding.length,
        feedbackCount: pendingFeedback.length,
        followUpCount: pendingFollowUp.length,
        activeTodayCount: pendingRecent.length,
      },
      queues: {
        needsBinding: pendingNeedsBinding,
        feedback: pendingFeedback,
        followUp: pendingFollowUp,
        recent: pendingRecent,
      },
    },
    users: {
      summary,
      rows: users,
    },
    instanceSummary: {
      total: dashboardData?.summary?.totalCount || (dashboardData?.instances || []).length,
      occupied: dashboardData?.summary?.occupiedCount || 0,
      open: dashboardData?.summary?.openedCount || 0,
      empty: dashboardData?.summary?.emptyCount || 0,
      attention: attentionCount,
    },
  };
}

function roundUsageUsd(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6;
}

function roundUsageRatio(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function parseIsoTimestampMs(value) {
  const timestampMs = Date.parse(String(value || '').trim());
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function createUsageAnalyticsBucket(extra = {}) {
  return {
    ...extra,
    runCount: 0,
    exactCostRunCount: 0,
    estimatedCostRunCount: 0,
    costedRunCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costedTokenCount: 0,
    costUsd: 0,
    estimatedCostUsd: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    backgroundTokens: 0,
    backgroundRuns: 0,
    foregroundTokens: 0,
    foregroundRuns: 0,
    maxContextTokens: null,
    maxContextWindowTokens: null,
    latestTimestamp: '',
    latestTimestampMs: null,
  };
}

function appendUsageAnalyticsMetrics(target, metrics = {}) {
  target.runCount += Number(metrics.runCount || 0);
  target.exactCostRunCount += Number(metrics.exactCostRunCount || 0);
  target.estimatedCostRunCount += Number(metrics.estimatedCostRunCount || 0);
  target.costedRunCount += Number(metrics.costedRunCount || 0);
  target.inputTokens += Number(metrics.inputTokens || 0);
  target.outputTokens += Number(metrics.outputTokens || 0);
  target.totalTokens += Number(metrics.totalTokens || 0);
  target.costedTokenCount += Number(metrics.costedTokenCount || 0);
  target.costUsd = roundUsageUsd((target.costUsd || 0) + Number(metrics.costUsd || 0));
  target.estimatedCostUsd = roundUsageUsd((target.estimatedCostUsd || 0) + Number(metrics.estimatedCostUsd || 0));
  target.cachedInputTokens += Number(metrics.cachedInputTokens || 0);
  target.reasoningTokens += Number(metrics.reasoningTokens || 0);
  target.backgroundTokens += Number(metrics.backgroundTokens || 0);
  target.backgroundRuns += Number(metrics.backgroundRuns || 0);
  target.foregroundTokens += Number(metrics.foregroundTokens || 0);
  target.foregroundRuns += Number(metrics.foregroundRuns || 0);
  if (Number.isInteger(metrics.maxContextTokens)) {
    target.maxContextTokens = target.maxContextTokens === null
      ? metrics.maxContextTokens
      : Math.max(target.maxContextTokens, metrics.maxContextTokens);
  }
  if (Number.isInteger(metrics.maxContextWindowTokens)) {
    target.maxContextWindowTokens = target.maxContextWindowTokens === null
      ? metrics.maxContextWindowTokens
      : Math.max(target.maxContextWindowTokens, metrics.maxContextWindowTokens);
  }
}

function touchUsageAnalyticsTimestamp(target, source = {}) {
  const timestamp = trimString(source.latestTimestamp || source.ts || source.lastSessionAt);
  const timestampMs = parseIsoTimestampMs(timestamp);
  if (!Number.isFinite(timestampMs)) return;
  if (!Number.isFinite(target.latestTimestampMs) || timestampMs >= target.latestTimestampMs) {
    target.latestTimestamp = new Date(timestampMs).toISOString();
    target.latestTimestampMs = timestampMs;
  }
}

function getOrCreateUsageAnalyticsBucket(map, key, extra = {}) {
  if (!map.has(key)) {
    map.set(key, createUsageAnalyticsBucket({ key, ...extra }));
  }
  return map.get(key);
}

function sortUsageAnalyticsBuckets(map, limit = Infinity) {
  return [...map.values()]
    .map((bucket) => ({
      ...bucket,
      costUsd: roundUsageUsd(bucket.costUsd || 0),
      estimatedCostUsd: roundUsageUsd(bucket.estimatedCostUsd || 0),
      unpricedRunCount: Math.max(0, (bucket.runCount || 0) - (bucket.costedRunCount || 0)),
      unpricedTokenCount: Math.max(0, (bucket.totalTokens || 0) - (bucket.costedTokenCount || 0)),
      costCoverageShare: (bucket.totalTokens || 0) > 0
        ? roundUsageRatio((bucket.costedTokenCount || 0) / bucket.totalTokens)
        : null,
      backgroundShare: (bucket.totalTokens || 0) > 0
        ? roundUsageRatio((bucket.backgroundTokens || 0) / bucket.totalTokens)
        : null,
    }))
    .sort((left, right) => {
      if ((right.totalTokens || 0) !== (left.totalTokens || 0)) {
        return (right.totalTokens || 0) - (left.totalTokens || 0);
      }
      const rightCost = (right.costUsd || 0) + (right.estimatedCostUsd || 0);
      const leftCost = (left.costUsd || 0) + (left.estimatedCostUsd || 0);
      if (rightCost !== leftCost) {
        return rightCost - leftCost;
      }
      return String(left.key || '').localeCompare(String(right.key || ''));
    })
    .slice(0, limit);
}

function usageTotalsPresent(totals = {}) {
  return Number(totals.totalTokens || 0) > 0
    || Number(totals.runCount || 0) > 0
    || Number(totals.costUsd || 0) > 0
    || Number(totals.estimatedCostUsd || 0) > 0;
}

function buildFleetUsageSummary(instances = []) {
  const totals = createUsageAnalyticsBucket();
  const byTool = new Map();
  const byModel = new Map();
  let activeInstanceCount = 0;
  let windowDays = DEFAULT_USAGE_WINDOW_DAYS;

  for (const instance of Array.isArray(instances) ? instances : []) {
    const usageSummary = instance?.usage?.usageSummary || null;
    const usageTotals = usageSummary?.totals || {};
    const hasUsage = Number(usageSummary?.runCount || 0) > 0 || usageTotalsPresent(usageTotals);
    if (!hasUsage) continue;

    activeInstanceCount += 1;
    windowDays = Number(usageSummary?.window?.days || windowDays) || windowDays;
    appendUsageAnalyticsMetrics(totals, {
      runCount: Number(usageSummary?.runCount || usageTotals.runCount || 0),
      ...usageTotals,
    });
    touchUsageAnalyticsTimestamp(totals, usageTotals);
    mergeUsageBreakdown(byTool, usageSummary?.byTool, (item, key) => ({ label: trimString(item?.label) || key }));
    mergeUsageBreakdown(byModel, usageSummary?.byModel, (item, key) => ({ label: trimString(item?.label) || key }));
  }

  return {
    windowDays,
    activeInstanceCount,
    runCount: totals.runCount,
    exactCostRunCount: totals.exactCostRunCount,
    estimatedCostRunCount: totals.estimatedCostRunCount,
    costedRunCount: totals.costedRunCount,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    costedTokenCount: totals.costedTokenCount,
    costUsd: roundUsageUsd(totals.costUsd || 0),
    estimatedCostUsd: roundUsageUsd(totals.estimatedCostUsd || 0),
    unpricedRunCount: Math.max(0, (totals.runCount || 0) - (totals.costedRunCount || 0)),
    unpricedTokenCount: Math.max(0, (totals.totalTokens || 0) - (totals.costedTokenCount || 0)),
    costCoverageShare: totals.totalTokens > 0
      ? roundUsageRatio((totals.costedTokenCount || 0) / totals.totalTokens)
      : null,
    byTool: sortUsageAnalyticsBuckets(byTool, DEFAULT_USAGE_BREAKDOWN_TOP),
    byModel: sortUsageAnalyticsBuckets(byModel, DEFAULT_USAGE_BREAKDOWN_TOP),
  };
}

function mergeUsageBreakdown(map, items = [], decorate = null) {
  for (const item of Array.isArray(items) ? items : []) {
    const key = trimString(item?.key || item?.label);
    if (!key) continue;
    const extra = decorate ? decorate(item, key) : {};
    const bucket = getOrCreateUsageAnalyticsBucket(map, key, {
      label: trimString(item?.label) || key,
      ...extra,
    });
    appendUsageAnalyticsMetrics(bucket, item);
    touchUsageAnalyticsTimestamp(bucket, item);
  }
}

function finalizeUsageEntity(entry) {
  const topModel = sortUsageAnalyticsBuckets(entry._models || new Map(), 1)[0] || null;
  const topTool = sortUsageAnalyticsBuckets(entry._tools || new Map(), 1)[0] || null;
  const topCategory = sortUsageAnalyticsBuckets(entry._categories || new Map(), 1)[0] || null;
  const topGroup = sortUsageAnalyticsBuckets(entry._groups || new Map(), 1)[0] || null;
  const {
    _models,
    _tools,
    _categories,
    _groups,
    ...publicEntry
  } = entry;
  return {
    ...publicEntry,
    costUsd: roundUsageUsd(publicEntry.costUsd || 0),
    estimatedCostUsd: roundUsageUsd(publicEntry.estimatedCostUsd || 0),
    unpricedRunCount: Math.max(0, (publicEntry.runCount || 0) - (publicEntry.costedRunCount || 0)),
    unpricedTokenCount: Math.max(0, (publicEntry.totalTokens || 0) - (publicEntry.costedTokenCount || 0)),
    costCoverageShare: (publicEntry.totalTokens || 0) > 0
      ? roundUsageRatio((publicEntry.costedTokenCount || 0) / publicEntry.totalTokens)
      : null,
    backgroundShare: (publicEntry.totalTokens || 0) > 0
      ? roundUsageRatio((publicEntry.backgroundTokens || 0) / publicEntry.totalTokens)
      : null,
    topModel,
    topTool,
    topCategory,
    topGroup,
  };
}

function buildBillingAnalyticsPayload({
  dashboardData,
  workbenchPayload,
} = {}) {
  const instances = Array.isArray(dashboardData?.instances) ? dashboardData.instances : [];
  const users = Array.isArray(workbenchPayload?.users?.rows) ? workbenchPayload.users.rows : [];
  const userByInstance = new Map(users.filter((user) => user.instanceName).map((user) => [user.instanceName, user]));

  const totals = createUsageAnalyticsBucket();
  const byModel = new Map();
  const byTool = new Map();
  const byOperation = new Map();
  const byOperationGroup = new Map();
  const byOperationCategory = new Map();
  const byInstance = new Map();
  const byUser = new Map();
  const topRuns = [];
  let instancesWithUsage = 0;
  let unattributedTokens = 0;
  let unattributedRuns = 0;
  let windowStartMs = null;
  let windowEndMs = null;
  let windowDays = 0;

  for (const instance of instances) {
    const usageSummary = instance?.usage?.usageSummary || null;
    const usageTotals = usageSummary?.totals || {};
    if (!usageTotalsPresent(usageTotals)) continue;

    instancesWithUsage += 1;
    appendUsageAnalyticsMetrics(totals, usageTotals);
    touchUsageAnalyticsTimestamp(totals, usageTotals);

    const summaryWindow = usageSummary?.window || {};
    const startMs = parseIsoTimestampMs(summaryWindow.start);
    const endMs = parseIsoTimestampMs(summaryWindow.end);
    if (Number.isFinite(startMs)) {
      windowStartMs = windowStartMs === null ? startMs : Math.min(windowStartMs, startMs);
    }
    if (Number.isFinite(endMs)) {
      windowEndMs = windowEndMs === null ? endMs : Math.max(windowEndMs, endMs);
    }
    if (Number(summaryWindow.days || 0) > windowDays) {
      windowDays = Number(summaryWindow.days || 0);
    }

    const boundUser = userByInstance.get(instance.name) || null;
    const userKey = boundUser ? normalizeUserKey(boundUser.userName) : '';
    const usageHealth = classifyInstanceHealth(instance);

    const instanceEntry = getOrCreateUsageAnalyticsBucket(byInstance, instance.name, {
      label: instance.name,
      instanceName: instance.name,
      userName: trimString(boundUser?.userName) || trimString(instance?.occupancy?.userName),
      source: trimString(boundUser?.source),
      healthKey: usageHealth.key,
      healthLabel: usageHealth.label,
      usageStatus: trimString(instance?.usage?.usageStatus),
      publicBaseUrl: trimString(instance?.publicBaseUrl),
      publicAccessUrl: trimString(instance?.publicAccessUrl),
      localBaseUrl: trimString(instance?.localBaseUrl),
      port: instance?.port,
      _models: new Map(),
      _tools: new Map(),
      _categories: new Map(),
      _groups: new Map(),
    });
    appendUsageAnalyticsMetrics(instanceEntry, usageTotals);
    touchUsageAnalyticsTimestamp(instanceEntry, usageTotals);
    mergeUsageBreakdown(instanceEntry._models, usageSummary?.byModel, (item, key) => ({ label: trimString(item?.label) || key }));
    mergeUsageBreakdown(instanceEntry._tools, usageSummary?.byTool, (item, key) => ({ label: trimString(item?.label) || key }));
    mergeUsageBreakdown(instanceEntry._categories, usageSummary?.byOperationCategory, (item, key) => ({
      label: trimString(item?.label) || key,
      operationGroup: trimString(item?.operationGroup),
    }));
    mergeUsageBreakdown(instanceEntry._groups, usageSummary?.byOperationGroup, (item, key) => ({ label: trimString(item?.label) || key }));

    if (boundUser) {
      const userEntry = getOrCreateUsageAnalyticsBucket(byUser, userKey, {
        label: boundUser.userName,
        userKey,
        userName: boundUser.userName,
        source: trimString(boundUser.source),
        lifecycleLabel: trimString(boundUser.lifecycleLabel),
        bindingStatus: trimString(boundUser.bindingStatus),
        instanceNames: [],
        _models: new Map(),
        _tools: new Map(),
        _categories: new Map(),
        _groups: new Map(),
      });
      appendUsageAnalyticsMetrics(userEntry, usageTotals);
      touchUsageAnalyticsTimestamp(userEntry, usageTotals);
      if (!userEntry.instanceNames.includes(instance.name)) {
        userEntry.instanceNames.push(instance.name);
      }
      mergeUsageBreakdown(userEntry._models, usageSummary?.byModel, (item, key) => ({ label: trimString(item?.label) || key }));
      mergeUsageBreakdown(userEntry._tools, usageSummary?.byTool, (item, key) => ({ label: trimString(item?.label) || key }));
      mergeUsageBreakdown(userEntry._categories, usageSummary?.byOperationCategory, (item, key) => ({
        label: trimString(item?.label) || key,
        operationGroup: trimString(item?.operationGroup),
      }));
      mergeUsageBreakdown(userEntry._groups, usageSummary?.byOperationGroup, (item, key) => ({ label: trimString(item?.label) || key }));
    } else {
      unattributedTokens += Number(usageTotals.totalTokens || 0);
      unattributedRuns += Number(usageTotals.runCount || 0);
    }

    mergeUsageBreakdown(byModel, usageSummary?.byModel, (item, key) => ({ label: trimString(item?.label) || key }));
    mergeUsageBreakdown(byTool, usageSummary?.byTool, (item, key) => ({ label: trimString(item?.label) || key }));
    mergeUsageBreakdown(byOperation, usageSummary?.byOperation, (item, key) => {
      const classified = classifyUsageOperation(key);
      return {
        label: trimString(item?.label) || classified.label || key,
        operationGroup: classified.group,
        operationCategory: classified.category,
        backgroundOperation: classified.background,
      };
    });
    mergeUsageBreakdown(byOperationGroup, usageSummary?.byOperationGroup, (item, key) => ({ label: trimString(item?.label) || key }));
    mergeUsageBreakdown(byOperationCategory, usageSummary?.byOperationCategory, (item, key) => ({
      label: trimString(item?.label) || key,
      operationGroup: trimString(item?.operationGroup),
    }));

    for (const run of Array.isArray(usageSummary?.topRuns) ? usageSummary.topRuns : []) {
      const classified = classifyUsageOperation(run);
      topRuns.push({
        ...run,
        instanceName: instance.name,
        userName: trimString(boundUser?.userName) || '',
        source: trimString(boundUser?.source) || '',
        operationGroup: trimString(run.operationGroup) || classified.group,
        operationCategory: trimString(run.operationCategory) || classified.category,
        operationLabel: trimString(run.operationLabel) || classified.label,
        backgroundOperation: run.backgroundOperation === true || classified.background,
      });
    }
  }

  const userRows = sortUsageAnalyticsBuckets(byUser, 200).map((entry) => finalizeUsageEntity(entry));
  const instanceRows = sortUsageAnalyticsBuckets(byInstance, 200).map((entry) => finalizeUsageEntity(entry));
  const operationRows = sortUsageAnalyticsBuckets(byOperation, 50).map((entry) => ({
    ...entry,
    operationGroup: trimString(entry.operationGroup),
    operationCategory: trimString(entry.operationCategory),
    backgroundOperation: entry.backgroundOperation === true,
  }));
  const operationGroupRows = sortUsageAnalyticsBuckets(byOperationGroup, 10);
  const operationCategoryRows = sortUsageAnalyticsBuckets(byOperationCategory, 20).map((entry) => ({
    ...entry,
    operationGroup: trimString(entry.operationGroup),
  }));

  const sortedTopRuns = topRuns
    .sort((left, right) => {
      if ((right.totalTokens || 0) !== (left.totalTokens || 0)) {
        return (right.totalTokens || 0) - (left.totalTokens || 0);
      }
      const rightCost = Number(right.costUsd || 0) + Number(right.estimatedCostUsd || 0);
      const leftCost = Number(left.costUsd || 0) + Number(left.estimatedCostUsd || 0);
      if (rightCost !== leftCost) {
        return rightCost - leftCost;
      }
      return (parseIsoTimestampMs(right.ts) || 0) - (parseIsoTimestampMs(left.ts) || 0);
    })
    .slice(0, 40);

  const summary = {
    runCount: totals.runCount,
    exactCostRunCount: totals.exactCostRunCount,
    estimatedCostRunCount: totals.estimatedCostRunCount,
    costedRunCount: totals.costedRunCount,
    totalTokens: totals.totalTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    costedTokenCount: totals.costedTokenCount,
    cachedInputTokens: totals.cachedInputTokens,
    reasoningTokens: totals.reasoningTokens,
    costUsd: roundUsageUsd(totals.costUsd || 0),
    estimatedCostUsd: roundUsageUsd(totals.estimatedCostUsd || 0),
    unpricedRunCount: Math.max(0, (totals.runCount || 0) - (totals.costedRunCount || 0)),
    unpricedTokenCount: Math.max(0, (totals.totalTokens || 0) - (totals.costedTokenCount || 0)),
    costCoverageShare: totals.totalTokens > 0
      ? roundUsageRatio((totals.costedTokenCount || 0) / totals.totalTokens)
      : null,
    backgroundTokens: totals.backgroundTokens,
    foregroundTokens: totals.foregroundTokens,
    backgroundRuns: totals.backgroundRuns,
    foregroundRuns: totals.foregroundRuns,
    backgroundShare: totals.totalTokens > 0 ? roundUsageRatio(totals.backgroundTokens / totals.totalTokens) : null,
    instanceCount: instances.length,
    instancesWithUsage,
    userCount: users.length,
    usersWithUsage: userRows.length,
    unattributedTokens,
    unattributedRuns,
    topCategory: operationCategoryRows[0] || null,
    topOperation: operationRows[0] || null,
    topModel: sortUsageAnalyticsBuckets(byModel, 1)[0] || null,
    topTool: sortUsageAnalyticsBuckets(byTool, 1)[0] || null,
  };

  return {
    attributionMode: 'instance_binding',
    summary,
    window: {
      days: windowDays || 0,
      start: windowStartMs ? new Date(windowStartMs).toISOString() : '',
      end: windowEndMs ? new Date(windowEndMs).toISOString() : '',
    },
    byUser: userRows,
    byInstance: instanceRows,
    byModel: sortUsageAnalyticsBuckets(byModel, 20),
    byTool: sortUsageAnalyticsBuckets(byTool, 20),
    byOperation: operationRows,
    byOperationGroup: operationGroupRows,
    byOperationCategory: operationCategoryRows,
    topRuns: sortedTopRuns,
  };
}

// --- Rate limiting ---

const failedAttempts = new Map(); // ip → { count, lastAttempt }

function isRateLimited(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.lastAttempt > 60_000) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= 5;
}

function recordFailure(ip) {
  const entry = failedAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  entry.count++;
  entry.lastAttempt = Date.now();
  failedAttempts.set(ip, entry);
}

function clearFailures(ip) {
  failedAttempts.delete(ip);
}

function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '';
}

// --- Route handlers ---

async function serveLogin(req, res, error = false) {
  const html = await readFile(LOGIN_TEMPLATE_PATH, 'utf8');
  const rendered = html.replace('{{ERROR_CLASS}}', error ? '' : 'hidden');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(rendered);
}

async function handleLogin(req, res) {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
    res.end('Too many failed attempts. Try again later.');
    return;
  }
  const body = await readBody(req);
  let valid = false;
  if (body.type === 'token') {
    valid = await verifyToken(body.token || '');
  } else {
    valid = await verifyPassword(body.username || '', body.password || '');
  }
  if (valid) {
    clearFailures(ip);
    const token = createSession();
    res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookie(token) });
    res.end();
  } else {
    recordFailure(ip);
    res.writeHead(302, { Location: '/login?error=1' });
    res.end();
  }
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req.headers['cookie'] || '');
  const st = cookies[SESSION_COOKIE];
  if (st) sessions.delete(st);
  res.writeHead(302, { Location: '/login', 'Set-Cookie': clearSessionCookie() });
  res.end();
}

async function servePage(req, res) {
  const html = await readFile(TEMPLATE_PATH, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// --- Dashboard cache ---

let dashboardCache = {
  data: null,
  updatedAt: 0,
  refreshPromise: null,
  hasChecks: false,
  refreshIncludesChecks: false,
};
let engagementCache = { data: null, updatedAt: 0, refreshPromise: null };
let workbenchCache = {
  data: null,
  updatedAt: 0,
  refreshPromise: null,
  dashboardUpdatedAt: 0,
  refreshDashboardUpdatedAt: 0,
};
let billingCache = {
  data: null,
  updatedAt: 0,
  refreshPromise: null,
  dashboardUpdatedAt: 0,
  workbenchUpdatedAt: 0,
  refreshDashboardUpdatedAt: 0,
  refreshWorkbenchUpdatedAt: 0,
};

async function probeBuildInfo(baseUrl, timeoutMs = 4000) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return { ok: null, body: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizedBaseUrl}/api/build-info`, {
      redirect: 'manual',
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, body };
  } catch {
    return { ok: false, body: null };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCloudflaredPublicBaseUrl(port) {
  const content = await readTextFileSafe(join(HOME, '.cloudflared', 'config.yml'));
  for (const entry of parseCloudflaredIngress(content)) {
    if (extractServicePort(entry.service) !== Number(port)) continue;
    const hostname = trimString(entry.hostname);
    if (hostname) return `https://${hostname}`;
  }
  return '';
}

async function buildOwnerInstanceRecord({ includeChecks = false } = {}) {
  const [ownerPlistContent, legacyOwnerAuth] = await Promise.all([
    readTextFileSafe(OWNER_LAUNCH_AGENT_PATH),
    readJsonFileSafe(OWNER_AUTH_FILE, {}),
  ]);

  const ownerEnv = extractPlistDictStrings(ownerPlistContent, 'EnvironmentVariables');
  const ownerLabel = trimString(extractPlistString(ownerPlistContent, 'Label')) || 'com.chatserver.claude';
  const ownerPort = Number.parseInt(trimString(ownerEnv.CHAT_PORT) || '7690', 10) || 7690;
  const instanceRoot = trimString(ownerEnv.REMOTELAB_INSTANCE_ROOT);
  const configDir = trimString(ownerEnv.REMOTELAB_CONFIG_DIR)
    || (instanceRoot ? join(instanceRoot, 'config') : OWNER_CONFIG_DIR);
  const memoryDir = trimString(ownerEnv.REMOTELAB_MEMORY_DIR)
    || (instanceRoot ? join(instanceRoot, 'memory') : OWNER_MEMORY_DIR);
  const authFile = join(configDir, 'auth.json');
  const [ownerAuth, rawSessions, authSessions, cloudPublicBaseUrl] = await Promise.all([
    readJsonFileSafe(authFile, legacyOwnerAuth || {}),
    readJsonFileSafe(join(configDir, 'chat-sessions.json'), []),
    readJsonFileSafe(join(configDir, 'auth-sessions.json'), []),
    resolveCloudflaredPublicBaseUrl(ownerPort),
  ]);

  if (!ownerPlistContent && !trimString(ownerAuth?.token) && !countCollection(rawSessions) && !countCollection(authSessions)) {
    return null;
  }

  const token = trimString(ownerAuth?.token);
  const publicBaseUrl = normalizeBaseUrl(ownerEnv.REMOTELAB_PUBLIC_BASE_URL) || cloudPublicBaseUrl;
  const guestAccessDefaults = await loadInstanceAccessDefaults({
    defaultsFilePath: GUEST_DEFAULTS_FILE,
    env: ownerEnv,
  });
  const bridgeBaseUrl = resolveBridgeBaseUrl({
    instanceName: 'owner',
    explicitBaseUrl: ownerEnv.REMOTELAB_BRIDGE_BASE_URL,
    bridgeBaseUrlTemplate: ownerEnv.REMOTELAB_BRIDGE_BASE_URL_TEMPLATE
      || guestAccessDefaults.bridgeBaseUrlTemplate,
    bridgeRootBaseUrl: ownerEnv.REMOTELAB_BRIDGE_ROOT_BASE_URL
      || guestAccessDefaults.bridgeRootBaseUrl,
  });
  const localBaseUrl = `http://127.0.0.1:${ownerPort}`;
  const sessions = normalizeSessionRecords(rawSessions);
  const lastSessionAt = sessions
    .map((session) => trimString(
      session?.updatedAt
      || session?.lastMessageAt
      || session?.createdAt
      || session?.created
      || ''
    ))
    .filter(Boolean)
    .sort(compareIsoTimestampsDesc)[0] || '';
  const usageSummary = await queryUsageLedger({
    ledgerDir: join(configDir, 'usage-ledger'),
    days: DEFAULT_USAGE_WINDOW_DAYS,
    top: DEFAULT_USAGE_BREAKDOWN_TOP,
  }).catch(() => null);
  const usageSnapshot = {
    sessionCount: sessions.length,
    authSessionCount: countCollection(authSessions),
    lastSessionAt,
  };
  const derivedUsageStatus = resolveInstanceUsageStatus(usageSnapshot);
  const [localReachability, publicReachability] = includeChecks
    ? await Promise.all([
        probeBuildInfo(localBaseUrl, 1500),
        publicBaseUrl ? probeBuildInfo(publicBaseUrl, 4000) : Promise.resolve({ ok: null }),
      ])
    : [{ ok: null }, { ok: null }];

  return attachInstanceAccess({
    name: 'owner',
    label: ownerLabel,
    kind: 'owner',
    port: ownerPort,
    instanceRoot,
    configDir,
    memoryDir,
    authFile,
    launchAgentPath: OWNER_LAUNCH_AGENT_PATH,
    publicBaseUrl,
    localBaseUrl,
    token,
    localReachable: localReachability.ok === null ? null : localReachability.ok === true,
    publicReachable: publicReachability.ok === null ? null : publicReachability.ok === true,
    build: includeChecks
      ? buildInstanceVersionState({
        local: normalizeBuildSummary(localReachability.body),
        publicBuild: normalizeBuildSummary(publicReachability.body),
      })
      : null,
    assignable: false,
    occupancy: {
      instanceName: 'owner',
      userName: 'Owner',
      handoffNote: '主控制台，不对外分配。',
      kind: 'assigned',
      usageStatus: 'active',
    },
    usage: {
      ...usageSnapshot,
      usageStatus: (derivedUsageStatus === 'opened' || derivedUsageStatus === 'empty') ? 'active' : derivedUsageStatus,
      usageBrief: 'owner 控制台',
      usageSummary,
    },
  }, {
    token,
    bridgeBaseUrl,
  });
}

async function fetchDashboardData({ includeChecks = false } = {}) {
  const [links, report, trialOccupancyText, ownerRecord] = await Promise.all([
    cli(['guest-instance', 'links', '--json', ...(includeChecks ? ['--check'] : [])]),
    cli(['guest-instance', 'report', '--json']).catch(() => ({ instances: [], summary: {} })),
    readTextFileSafe(TRIAL_OCCUPANCY_LEDGER_FILE),
    buildOwnerInstanceRecord({ includeChecks }),
  ]);
  const reportInstances = report.instances || report.rows || [];
  const usageMap = new Map(reportInstances.map(r => [r.name, {
    sessionCount: r.sessionCount,
    authSessionCount: r.authSessionCount,
    lastSessionAt: r.lastSessionAt,
    usageStatus: r.status,
    usageBrief: r.brief,
    usageSummary: r.usageSummary || null,
  }]));
  const occupancyEntries = parseTrialOccupancyLedger(trialOccupancyText);
  const guestInstances = (Array.isArray(links) ? links : []).map((inst) => applyOccupancyOverlay({
    ...inst,
    usage: usageMap.get(inst.name) || null,
  }, occupancyEntries.get(inst.name) || null));
  const instances = ownerRecord ? [ownerRecord, ...guestInstances] : guestInstances;
  return {
    instances,
    summary: computeDashboardSummary(instances, { usage: buildFleetUsageSummary(instances) }),
  };
}

async function refreshDashboardCache({ includeChecks = false } = {}) {
  if (dashboardCache.refreshPromise) {
    if (!includeChecks || dashboardCache.refreshIncludesChecks) return dashboardCache.refreshPromise;
    try {
      await dashboardCache.refreshPromise;
    } catch {}
    if (dashboardCache.data && dashboardCache.hasChecks) return dashboardCache.data;
  }

  const refreshPromise = (async () => {
    const data = await fetchDashboardData({ includeChecks });
    dashboardCache.data = data;
    dashboardCache.updatedAt = Date.now();
    dashboardCache.hasChecks = includeChecks;
    return data;
  })();

  dashboardCache.refreshPromise = refreshPromise;
  dashboardCache.refreshIncludesChecks = includeChecks;

  try {
    return await refreshPromise;
  } finally {
    if (dashboardCache.refreshPromise === refreshPromise) {
      dashboardCache.refreshPromise = null;
      dashboardCache.refreshIncludesChecks = false;
    }
  }
}

async function getDashboardData({ force = false, includeChecks = false } = {}) {
  if (!force && isCacheFresh(dashboardCache, DASHBOARD_CACHE_TTL_MS) && (!includeChecks || dashboardCache.hasChecks)) {
    return dashboardCache.data;
  }
  return refreshDashboardCache({ includeChecks });
}

async function apiDashboard(req, res) {
  const force = requestFlag(req, 'refresh') || requestFlag(req, 'force');
  const includeChecks = requestFlag(req, 'checks') || force;
  const data = await getDashboardData({ force, includeChecks });
  json(res, {
    ...data,
    cachedAt: cacheIso(dashboardCache.updatedAt),
    checksIncluded: dashboardCache.hasChecks,
  });
}

async function apiCreate(req, res) {
  const data = await readBody(req);
  const args = ['guest-instance'];
  if (data.trial) {
    args.push('create-trial');
  } else {
    const name = sanitize(data.name);
    if (!name) return json(res, { error: 'Name is required' }, 400);
    args.push('create', name);
  }
  if (data.localOnly) args.push('--local-only');
  args.push('--json');

  const result = await cli(args, 180_000);
  invalidateAdminCaches();
  json(res, result, 201);
}

async function apiInstanceAction(res, name, action) {
  const safe = sanitize(name);
  if (!safe) return json(res, { error: 'Invalid name' }, 400);

  try {
    if (process.platform === 'darwin') {
      const dashboardData = await getDashboardData();
      const instance = (dashboardData?.instances || []).find((entry) => entry.name === safe) || null;
      const plist = trimString(instance?.launchAgentPath) || join(LAUNCH_AGENTS_DIR, `com.chatserver.${safe}.plist`);
      if (action === 'stop') {
        await execFileAsync('launchctl', ['unload', plist], { timeout: 10_000 });
      } else if (action === 'start') {
        await execFileAsync('launchctl', ['load', plist], { timeout: 10_000 });
      } else if (action === 'restart') {
        await cli(['restart', 'chat'], 180_000);
        return json(res, { ok: true, action: 'restart-all-chat', requestedName: safe });
      }
    } else {
      const service = safe === 'owner' ? 'remotelab.service' : `remotelab-guest@${safe}.service`;
      await execFileAsync('systemctl', [action, service], { timeout: 30_000 });
    }
    invalidateAdminCaches();
    json(res, { ok: true, action, name: safe });
  } catch (err) {
    json(res, { ok: false, error: err.message || String(err) }, 500);
  }
}

async function apiDelete(res, name) {
  const safe = sanitize(name);
  if (!safe) return json(res, { error: 'Invalid name' }, 400);
  const dashboardData = await getDashboardData();
  const instance = (dashboardData?.instances || []).find((entry) => entry.name === safe) || null;
  if (instance?.kind === 'owner') {
    return json(res, { ok: false, error: 'Owner instance cannot be deleted' }, 400);
  }
  const plist = trimString(instance?.launchAgentPath) || join(LAUNCH_AGENTS_DIR, `com.chatserver.${safe}.plist`);

  if (process.platform === 'darwin') {
    await execFileAsync('launchctl', ['unload', plist], { timeout: 10_000 }).catch(() => {});
    await unlink(plist).catch(() => {});
  } else {
    const service = `remotelab-guest@${safe}.service`;
    await execFileAsync('systemctl', ['disable', '--now', service], { timeout: 30_000 }).catch(() => {});
    await unlink(join('/etc/remotelab/guest-instances', `${safe}.env`)).catch(() => {});
  }

  try {
    const registry = JSON.parse(await readFile(GUEST_REGISTRY_FILE, 'utf8'));
    const filtered = registry.filter(r => r.name !== safe);
    if (filtered.length < registry.length) {
      await writeFile(GUEST_REGISTRY_FILE, JSON.stringify(filtered, null, 2) + '\n');
    }
  } catch (err) {
    return json(res, { ok: false, error: 'Registry update failed: ' + err.message }, 500);
  }

  invalidateAdminCaches();
  json(res, { ok: true, name: safe, action: 'delete' });
}

async function apiConverge(req, res) {
  const result = await cli(['guest-instance', 'converge', '--all', '--json'], 180_000);
  invalidateAdminCaches();
  json(res, result);
}

// --- User engagement API ---

let engagementModule = null;

async function loadEngagementModule() {
  if (!engagementModule) {
    engagementModule = await import(join(PROJECT_ROOT, 'lib', 'user-engagement-check.mjs'));
  }
  return engagementModule;
}

async function refreshEngagementCache() {
  if (engagementCache.refreshPromise) return engagementCache.refreshPromise;
  engagementCache.refreshPromise = (async () => {
    const mod = await loadEngagementModule();
    const result = await mod.checkUserEngagement({ days: 14 }).catch(() => ({ users: [], actions: [], summary: {} }));
    engagementCache.data = result;
    engagementCache.updatedAt = Date.now();
    return result;
  })();
  try {
    return await engagementCache.refreshPromise;
  } finally {
    engagementCache.refreshPromise = null;
  }
}

async function getEngagementData({ force = false } = {}) {
  if (!force && isCacheFresh(engagementCache, ENGAGEMENT_CACHE_TTL_MS)) {
    return engagementCache.data;
  }
  return refreshEngagementCache();
}

async function apiUserEngagement(req, res) {
  const force = requestFlag(req, 'refresh') || requestFlag(req, 'force');
  const result = await getEngagementData({ force });
  json(res, {
    ...result,
    cachedAt: cacheIso(engagementCache.updatedAt),
  });
}

async function buildWorkbenchPayload(dashboardData = null, { forceEngagement = false } = {}) {
  const effectiveDashboardData = dashboardData || await getDashboardData();
  const [bindingsFile, ledgerText, eventLogText, engagement] = await Promise.all([
    readJsonFileSafe(USER_BINDINGS_FILE, { bindings: [] }),
    readTextFileSafe(USER_LEDGER_FILE),
    readTextFileSafe(USER_EVENT_LOG_FILE),
    getEngagementData({ force: forceEngagement }),
  ]);

  return buildUserWorkbenchPayload({
    dashboardData: effectiveDashboardData,
    bindings: Array.isArray(bindingsFile?.bindings) ? bindingsFile.bindings : [],
    ledgerCards: parseRelationshipLedger(ledgerText),
    eventLog: parseUserEventLog(eventLogText),
    engagement,
  });
}

async function getWorkbenchData({
  force = false,
  dashboardData = null,
  dashboardUpdatedAt = 0,
  forceEngagement = false,
} = {}) {
  const effectiveDashboardData = dashboardData || await getDashboardData();
  const effectiveDashboardUpdatedAt = dashboardUpdatedAt || dashboardCache.updatedAt;

  if (!force && isCacheFresh(workbenchCache, WORKBENCH_CACHE_TTL_MS) && workbenchCache.dashboardUpdatedAt === effectiveDashboardUpdatedAt) {
    return workbenchCache.data;
  }
  if (!force && workbenchCache.refreshPromise && workbenchCache.refreshDashboardUpdatedAt === effectiveDashboardUpdatedAt) {
    return workbenchCache.refreshPromise;
  }

  const refreshPromise = (async () => {
    const payload = await buildWorkbenchPayload(effectiveDashboardData, { forceEngagement });
    workbenchCache.data = payload;
    workbenchCache.updatedAt = Date.now();
    workbenchCache.dashboardUpdatedAt = effectiveDashboardUpdatedAt;
    return payload;
  })();

  workbenchCache.refreshPromise = refreshPromise;
  workbenchCache.refreshDashboardUpdatedAt = effectiveDashboardUpdatedAt;

  try {
    return await refreshPromise;
  } finally {
    if (workbenchCache.refreshPromise === refreshPromise) {
      workbenchCache.refreshPromise = null;
      workbenchCache.refreshDashboardUpdatedAt = 0;
    }
  }
}

async function apiWorkbench(req, res) {
  const force = requestFlag(req, 'refresh') || requestFlag(req, 'force');
  const includeChecks = requestFlag(req, 'checks') || force;
  const dashboardData = await getDashboardData({ force, includeChecks });
  const payload = await getWorkbenchData({
    force,
    dashboardData,
    dashboardUpdatedAt: dashboardCache.updatedAt,
    forceEngagement: force,
  });

  json(res, {
    ...payload,
    cachedAt: cacheIso(workbenchCache.updatedAt || dashboardCache.updatedAt),
    dashboardCachedAt: cacheIso(dashboardCache.updatedAt),
  });
}

async function getBillingData({
  force = false,
  dashboardData = null,
  dashboardUpdatedAt = 0,
  workbenchPayload = null,
  workbenchUpdatedAt = 0,
} = {}) {
  const effectiveDashboardData = dashboardData || await getDashboardData();
  const effectiveDashboardUpdatedAt = dashboardUpdatedAt || dashboardCache.updatedAt;
  const effectiveWorkbenchPayload = workbenchPayload || await getWorkbenchData({
    force,
    dashboardData: effectiveDashboardData,
    dashboardUpdatedAt: effectiveDashboardUpdatedAt,
    forceEngagement: force,
  });
  const effectiveWorkbenchUpdatedAt = workbenchUpdatedAt || workbenchCache.updatedAt;

  if (
    !force
    && isCacheFresh(billingCache, BILLING_CACHE_TTL_MS)
    && billingCache.dashboardUpdatedAt === effectiveDashboardUpdatedAt
    && billingCache.workbenchUpdatedAt === effectiveWorkbenchUpdatedAt
  ) {
    return billingCache.data;
  }
  if (
    !force
    && billingCache.refreshPromise
    && billingCache.refreshDashboardUpdatedAt === effectiveDashboardUpdatedAt
    && billingCache.refreshWorkbenchUpdatedAt === effectiveWorkbenchUpdatedAt
  ) {
    return billingCache.refreshPromise;
  }

  const refreshPromise = (async () => {
    const payload = buildBillingAnalyticsPayload({
      dashboardData: effectiveDashboardData,
      workbenchPayload: effectiveWorkbenchPayload,
    });
    billingCache.data = payload;
    billingCache.updatedAt = Date.now();
    billingCache.dashboardUpdatedAt = effectiveDashboardUpdatedAt;
    billingCache.workbenchUpdatedAt = effectiveWorkbenchUpdatedAt;
    return payload;
  })();

  billingCache.refreshPromise = refreshPromise;
  billingCache.refreshDashboardUpdatedAt = effectiveDashboardUpdatedAt;
  billingCache.refreshWorkbenchUpdatedAt = effectiveWorkbenchUpdatedAt;

  try {
    return await refreshPromise;
  } finally {
    if (billingCache.refreshPromise === refreshPromise) {
      billingCache.refreshPromise = null;
      billingCache.refreshDashboardUpdatedAt = 0;
      billingCache.refreshWorkbenchUpdatedAt = 0;
    }
  }
}

async function apiBilling(req, res) {
  const force = requestFlag(req, 'refresh') || requestFlag(req, 'force');
  const includeChecks = requestFlag(req, 'checks') || force;
  const dashboardData = await getDashboardData({ force, includeChecks });
  const workbenchPayload = await getWorkbenchData({
    force,
    dashboardData,
    dashboardUpdatedAt: dashboardCache.updatedAt,
    forceEngagement: force,
  });
  const payload = await getBillingData({
    force,
    dashboardData,
    dashboardUpdatedAt: dashboardCache.updatedAt,
    workbenchPayload,
    workbenchUpdatedAt: workbenchCache.updatedAt,
  });

  json(res, {
    ...payload,
    cachedAt: cacheIso(billingCache.updatedAt || workbenchCache.updatedAt || dashboardCache.updatedAt),
    dashboardCachedAt: cacheIso(dashboardCache.updatedAt),
    workbenchCachedAt: cacheIso(workbenchCache.updatedAt || dashboardCache.updatedAt),
  });
}

// --- Server ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  try {
    // --- Public routes (no auth required) ---
    if (path === '/login') {
      if (req.method === 'POST') return await handleLogin(req, res);
      return await serveLogin(req, res, url.searchParams.has('error'));
    }
    if (path === '/logout') return await handleLogout(req, res);

    // --- Auto-login via ?token= query param ---
    const queryToken = url.searchParams.get('token');
    if (queryToken && !checkAuth(req)) {
      const valid = await verifyToken(queryToken);
      if (valid) {
        const st = createSession();
        res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookie(st) });
        res.end();
        return;
      }
    }

    // --- Auth check ---
    if (!checkAuth(req)) {
      if (path.startsWith('/api/')) {
        return json(res, { error: 'Unauthorized' }, 401);
      }
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }

    // --- Protected routes ---
    if (req.method === 'GET' && path === '/') return await servePage(req, res);
    if (req.method === 'GET' && path === '/api/dashboard') return await apiDashboard(req, res);
    if (req.method === 'GET' && path === '/api/workbench') return await apiWorkbench(req, res);
    if (req.method === 'GET' && path === '/api/billing') return await apiBilling(req, res);
    if (req.method === 'GET' && path === '/api/user-engagement') return await apiUserEngagement(req, res);
    if (req.method === 'POST' && path === '/api/instances/create') return await apiCreate(req, res);
    if (req.method === 'POST' && path === '/api/converge') return await apiConverge(req, res);

    const m = path.match(/^\/api\/instances\/([a-z0-9-]+)\/(stop|start|restart|delete)$/);
    if (req.method === 'POST' && m) {
      if (m[2] === 'delete') return await apiDelete(res, m[1]);
      return await apiInstanceAction(res, m[1], m[2]);
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    console.error(`[${req.method} ${path}]`, err.message || err);
    if (!res.headersSent) json(res, { error: err.message || 'Internal error' }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Instance admin dashboard: http://${HOST}:${PORT}`);
});
