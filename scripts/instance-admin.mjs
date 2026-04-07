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

const scryptAsync = promisify(scrypt);
const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_PATH = join(PROJECT_ROOT, 'cli.js');
const TEMPLATE_PATH = join(PROJECT_ROOT, 'templates', 'instance-admin.html');
const LOGIN_TEMPLATE_PATH = join(PROJECT_ROOT, 'templates', 'admin-login.html');
const HOME = homedir();
const LAUNCH_AGENTS_DIR = join(HOME, 'Library', 'LaunchAgents');
const OWNER_AUTH_FILE = join(HOME, '.config', 'remotelab', 'auth.json');
const GUEST_REGISTRY_FILE = join(HOME, '.config', 'remotelab', 'guest-instances.json');
const USER_BINDINGS_FILE = join(HOME, '.config', 'remotelab', 'user-instance-bindings.json');
const USER_LEDGER_FILE = join(HOME, '.remotelab', 'memory', 'tasks', 'remotelab-user-relationship-ledger.md');
const USER_EVENT_LOG_FILE = join(HOME, '.remotelab', 'memory', 'tasks', 'remotelab-user-event-log.md');
const TRIAL_OCCUPANCY_LEDGER_FILE = join(HOME, '.remotelab', 'memory', 'tasks', 'remotelab-trial-user-ledger.md');
const SESSION_COOKIE = 'admin_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  };

  for (const instance of instances) {
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

function classifyInstanceHealth(instance) {
  if (!instance) {
    return { key: 'unknown', label: '待确认', tone: 'muted', detail: '当前还没有关联实例。' };
  }
  if (instance.localReachable === null && instance.publicReachable === null) {
    return { key: 'unknown', label: '待确认', tone: 'muted', detail: '健康探测尚未完成。' };
  }
  if (instance.localReachable && instance.publicReachable !== false) {
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
        mainlandAccessUrl: trimString(instance.mainlandAccessUrl) || trimString(instance.mainlandBaseUrl),
        localAccessUrl: trimString(instance.localAccessUrl) || trimString(instance.localBaseUrl),
      } : { publicAccessUrl: '', mainlandAccessUrl: '', localAccessUrl: '' },
      instanceDetail: instance ? {
        name: instance.name,
        port: instance.port,
        publicBaseUrl: trimString(instance.publicBaseUrl),
        mainlandBaseUrl: trimString(instance.mainlandBaseUrl),
        localBaseUrl: trimString(instance.localBaseUrl),
        publicAccessUrl: trimString(instance.publicAccessUrl),
        mainlandAccessUrl: trimString(instance.mainlandAccessUrl),
        localAccessUrl: trimString(instance.localAccessUrl),
        token: trimString(instance.token),
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

let dashboardCache = { data: null, updatedAt: 0, refreshPromise: null };
let engagementCache = { data: null, updatedAt: 0, refreshPromise: null };

async function fetchDashboardData() {
  const [links, report, trialOccupancyText] = await Promise.all([
    cli(['guest-instance', 'links', '--json', '--check']),
    cli(['guest-instance', 'report', '--json']).catch(() => ({ instances: [], summary: {} })),
    readTextFileSafe(TRIAL_OCCUPANCY_LEDGER_FILE),
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
  const instances = (Array.isArray(links) ? links : []).map((inst) => applyOccupancyOverlay({
    ...inst,
    usage: usageMap.get(inst.name) || null,
  }, occupancyEntries.get(inst.name) || null));
  return { instances, summary: computeDashboardSummary(instances, report.summary || null) };
}

async function refreshCache() {
  if (dashboardCache.refreshPromise) return dashboardCache.refreshPromise;
  dashboardCache.refreshPromise = (async () => {
    const data = await fetchDashboardData();
    dashboardCache.data = data;
    dashboardCache.updatedAt = Date.now();
    return data;
  })();
  try {
    return await dashboardCache.refreshPromise;
  } finally {
    dashboardCache.refreshPromise = null;
  }
}

async function getDashboardData({ force = false } = {}) {
  void force;
  return refreshCache();
}

async function apiDashboard(req, res) {
  const data = await getDashboardData();
  json(res, {
    ...data,
    cachedAt: new Date(dashboardCache.updatedAt).toISOString(),
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
  json(res, result, 201);
}

async function apiInstanceAction(res, name, action) {
  const safe = sanitize(name);
  if (!safe) return json(res, { error: 'Invalid name' }, 400);
  const plist = join(LAUNCH_AGENTS_DIR, `com.chatserver.${safe}.plist`);

  try {
    if (action === 'stop') {
      await execFileAsync('launchctl', ['unload', plist], { timeout: 10_000 });
    } else if (action === 'start') {
      await execFileAsync('launchctl', ['load', plist], { timeout: 10_000 });
    } else if (action === 'restart') {
      await cli(['restart', 'chat'], 180_000);
      return json(res, { ok: true, action: 'restart-all-chat', requestedName: safe });
    }
    json(res, { ok: true, action, name: safe });
  } catch (err) {
    json(res, { ok: false, error: err.message || String(err) }, 500);
  }
}

async function apiDelete(res, name) {
  const safe = sanitize(name);
  if (!safe) return json(res, { error: 'Invalid name' }, 400);
  const plist = join(LAUNCH_AGENTS_DIR, `com.chatserver.${safe}.plist`);

  // 1. Stop (unload LaunchAgent)
  await execFileAsync('launchctl', ['unload', plist], { timeout: 10_000 }).catch(() => {});

  // 2. Remove plist file
  await unlink(plist).catch(() => {});

  // 3. Remove from registry
  try {
    const registry = JSON.parse(await readFile(GUEST_REGISTRY_FILE, 'utf8'));
    const filtered = registry.filter(r => r.name !== safe);
    if (filtered.length < registry.length) {
      await writeFile(GUEST_REGISTRY_FILE, JSON.stringify(filtered, null, 2) + '\n');
    }
  } catch (err) {
    return json(res, { ok: false, error: 'Registry update failed: ' + err.message }, 500);
  }

  json(res, { ok: true, name: safe, action: 'delete' });
}

async function apiConverge(req, res) {
  const result = await cli(['guest-instance', 'converge', '--all', '--json'], 180_000);
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
  void force;
  return refreshEngagementCache();
}

async function apiUserEngagement(req, res) {
  const result = await getEngagementData();
  json(res, result);
}

async function apiWorkbench(req, res) {
  const [dashboardData, bindingsFile, ledgerText, eventLogText, engagement] = await Promise.all([
    getDashboardData(),
    readJsonFileSafe(USER_BINDINGS_FILE, { bindings: [] }),
    readTextFileSafe(USER_LEDGER_FILE),
    readTextFileSafe(USER_EVENT_LOG_FILE),
    getEngagementData(),
  ]);

  const payload = buildUserWorkbenchPayload({
    dashboardData,
    bindings: Array.isArray(bindingsFile?.bindings) ? bindingsFile.bindings : [],
    ledgerCards: parseRelationshipLedger(ledgerText),
    eventLog: parseUserEventLog(eventLogText),
    engagement,
  });

  json(res, {
    ...payload,
    cachedAt: new Date(dashboardCache.updatedAt).toISOString(),
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
