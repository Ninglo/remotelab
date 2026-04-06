#!/usr/bin/env node

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HOME = homedir();
const DEFAULT_CONFIG_PATH = join(HOME, '.config', 'remotelab', 'remote-capability-monitor', 'config.json');
const DEFAULT_STATE_PATH = join(HOME, '.config', 'remotelab', 'remote-capability-monitor', 'state.json');
const DEFAULT_REPORT_DIR = join(HOME, '.remotelab', 'research', 'remote-capability-monitor');
const DEFAULT_NOTIFICATION_DIR = join(HOME, '.config', 'remotelab', 'remote-capability-monitor', 'notifications');
const DEFAULT_NOTIFIER_PATH = join(HOME, '.remotelab', 'scripts', 'send-multi-channel-reminder.mjs');
const DEFAULT_REMOTELAB_BASE_URL = 'http://127.0.0.1:7690';
const DEFAULT_REMOTELAB_AUTH_FILE = join(HOME, '.config', 'remotelab', 'auth.json');
const DEFAULT_REMOTELAB_SESSION_FOLDER = join(HOME, 'code', 'remotelab');
const DEFAULT_BOOTSTRAP_HOURS = 168;
const DEFAULT_LOOKBACK_HOURS = 168;
const DEFAULT_MAX_ITEMS = 10;
const DEFAULT_NOTIFICATION_LOG = join(HOME, '.remotelab', 'logs', 'reminders', 'remote-capability-monitor.jsonl');
const FETCH_TIMEOUT_MS = 15000;
const INTERESTING_SCORE_THRESHOLD = 4;
const LOW_CONFIDENCE_SCORE_THRESHOLD = 6;
const STATE_RETENTION_DAYS = 90;
const RUN_POLL_INTERVAL_MS = 2000;
const RUN_POLL_TIMEOUT_MS = 10 * 60 * 1000;

const SIGNALS = [
  {
    key: 'explicit-remote-control',
    score: 5,
    reason: 'explicit remote-control positioning',
    proposal: 'Owner-first remote control cards with one-tap resume, approve, and nudge actions.',
    patterns: [
      /remote control/i,
      /puts? .* in your pocket/i,
      /control .* from .* (phone|mobile|browser)/i,
    ],
  },
  {
    key: 'mobile-surface',
    score: 3,
    reason: 'mobile-first surface emphasis',
    proposal: 'Phone-first layout with thumb-friendly quick actions, swipeable updates, and dense status cards.',
    patterns: [
      /\bmobile\b/i,
      /\bphone\b/i,
      /\biphone\b/i,
      /\bandroid\b/i,
      /\bpocket\b/i,
      /\bpwa\b/i,
    ],
  },
  {
    key: 'browser-delivery',
    score: 2,
    reason: 'browser-based delivery surface',
    proposal: 'Zero-install browser control with stronger reconnect recovery and instant deep-link resume.',
    patterns: [
      /\bbrowser\b/i,
      /web app/i,
      /from safari/i,
      /from chrome/i,
    ],
  },
  {
    key: 'notifications',
    score: 2,
    reason: 'notification or alert mechanics',
    proposal: 'Actionable notifications that let you approve, resume, summarize, or snooze from the alert itself.',
    patterns: [
      /\bpush\b/i,
      /notification/i,
      /\balert\b/i,
      /webhook/i,
    ],
  },
  {
    key: 'background-resume',
    score: 2,
    reason: 'background or resume mechanics',
    proposal: 'Detached run queues with resumable mobile handoff, catch-up digests, and scheduled wake-ups.',
    patterns: [
      /\bbackground\b/i,
      /detached/i,
      /\bresume\b/i,
      /\bcontinue\b/i,
      /asynchronous/i,
      /\basync\b/i,
      /\bcron\b/i,
      /scheduled/i,
    ],
  },
  {
    key: 'approvals',
    score: 2,
    reason: 'approval, permission, or sandbox mechanics',
    proposal: 'Batch permission inboxes with risk labels, one-tap approval policies, and checkpoint-aware guardrails.',
    patterns: [
      /approval/i,
      /permission/i,
      /allowlist/i,
      /sandbox/i,
      /checkpoint/i,
    ],
  },
  {
    key: 'voice',
    score: 1,
    reason: 'audio cleanup or spoken control',
    proposal: 'Voice briefings and spoken summaries for hands-busy control moments.',
    patterns: [
      /\bvoice\b/i,
      /speech/i,
      /transcription/i,
      /push-to-talk/i,
    ],
  },
  {
    key: 'workflow-packaging',
    score: 1,
    reason: 'shareable workflow or packaging primitive',
    proposal: 'Shareable remote-control playbooks and reusable operator apps around repeated tasks.',
    patterns: [
      /\bshare\b/i,
      /\btemplate\b/i,
      /\bworkflow\b/i,
      /\bplugin\b/i,
      /\bmarketplace\b/i,
    ],
  },
  {
    key: 'live-visual-feedback',
    score: 2,
    reason: 'live visual or preview feedback',
    proposal: 'Live status tiles with snapshots or screenshot diffs so long jobs stay legible from mobile.',
    patterns: [
      /\blive\b/i,
      /\bscreen\b/i,
      /\bpreview\b/i,
      /\bsnapshot\b/i,
      /\bvisual\b/i,
    ],
  },
];

function usage(exitCode = 0, errorMessage = '') {
  if (errorMessage) {
    console.error(errorMessage);
    console.error('');
  }
  const output = exitCode === 0 ? console.log : console.error;
  output(`Usage:
  node scripts/remote-capability-monitor.mjs [options]

Options:
  --config <path>           Monitor config path (default: ${DEFAULT_CONFIG_PATH})
  --state-file <path>       Override state file path
  --report-dir <path>       Override report output directory
  --bootstrap-hours <n>     First-run lookback window in hours (default: ${DEFAULT_BOOTSTRAP_HOURS})
  --force-notify            Send a digest even when there are no new high-signal items
  --dry-run                 Fetch and render reports without updating state or sending alerts
  --verbose                 Print per-source fetch details
  -h, --help                Show this help

Config shape:
  {
    "bootstrapHours": 168,
    "reportDir": "~/.remotelab/research/remote-capability-monitor",
    "notification": {
      "notifierPath": "~/.remotelab/scripts/send-multi-channel-reminder.mjs",
      "channels": [ ... ]
    },
    "sources": [ ... ]
  }

Source types:
  - "google_news_rss" with "query"
  - "rss" or "atom" with "url"
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    stateFile: '',
    reportDir: '',
    bootstrapHours: 0,
    dryRun: false,
    forceNotify: false,
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      options.configPath = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--state-file') {
      options.stateFile = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--report-dir') {
      options.reportDir = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--bootstrap-hours') {
      options.bootstrapHours = parseInteger(argv[index + 1], '--bootstrap-hours', 1);
      index += 1;
      continue;
    }
    if (arg === '--force-notify') {
      options.forceNotify = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      usage(0);
    }
    usage(1, `Unknown argument: ${arg}`);
  }

  if (!options.configPath) {
    usage(1, 'Missing --config value');
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

function trimString(value) {
  return String(value || '').trim();
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeBaseUrl(value) {
  const trimmed = trimString(value);
  return trimmed.replace(/\/+$/, '');
}

function expandHome(pathname) {
  const normalized = trimString(pathname);
  if (!normalized) return normalized;
  if (normalized.startsWith('~/')) {
    return join(HOME, normalized.slice(2));
  }
  return normalized;
}

async function readJson(pathname, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(pathname, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(pathname, value) {
  await fs.mkdir(dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(pathname, value) {
  await fs.mkdir(dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, value, 'utf8');
}

function stripCdata(value) {
  return String(value || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function decodeXmlEntities(value) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
}

function stripHtml(value) {
  const decoded = decodeXmlEntities(String(value || ''));
  return normalizeWhitespace(decoded.replace(/<[^>]+>/g, ' '));
}

function extractTag(block, tagName) {
  const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = String(block || '').match(regex);
  return match ? stripCdata(match[1]) : '';
}

function extractAtomLink(block) {
  const alternateMatch = String(block || '').match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"[^>]*\/?>/i);
  if (alternateMatch) return alternateMatch[1];
  const firstMatch = String(block || '').match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
  return firstMatch ? firstMatch[1] : '';
}

function extractRssSource(block) {
  const match = String(block || '').match(/<source(?:\s+url="([^"]+)")?>([\s\S]*?)<\/source>/i);
  if (!match) return { name: '', url: '' };
  return {
    name: normalizeWhitespace(decodeXmlEntities(stripCdata(match[2]))),
    url: trimString(match[1]),
  };
}

function normalizeDate(value) {
  const raw = trimString(value);
  if (!raw) return '';
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString();
}

function buildSourceUrl(source) {
  const type = trimString(source?.type).toLowerCase();
  if (type === 'google_news_rss') {
    const query = trimString(source?.query);
    if (!query) throw new Error(`Source ${source?.id || '(unknown)'} is missing query`);
    const hl = trimString(source?.hl) || 'en-US';
    const gl = trimString(source?.gl) || 'US';
    const ceid = trimString(source?.ceid) || 'US:en';
    return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
  }
  const url = trimString(source?.url);
  if (!url) throw new Error(`Source ${source?.id || '(unknown)'} is missing url`);
  return url;
}

function buildSessionUrl(sessionId) {
  const params = new URLSearchParams();
  if (sessionId) params.set('session', sessionId);
  params.set('tab', 'sessions');
  return `/?${params.toString()}`;
}

function buildItemId(item, source) {
  const seed = [
    normalizeWhitespace(item?.title).toLowerCase(),
    normalizeWhitespace(item?.publisher).toLowerCase(),
    trimString(source?.target || source?.id).toLowerCase(),
    trimString(item?.publishedAt).slice(0, 10),
  ].join('|');
  return createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

function buildHeadline(item, source) {
  const title = normalizeWhitespace(item?.title) || '(untitled)';
  if (/^v?\d[\w.-]*$/i.test(title) && trimString(source?.name)) {
    return `${source.name}: ${title}`;
  }
  return title;
}

function containsAny(text, values) {
  const normalized = Array.isArray(values) ? values.map((value) => trimString(value).toLowerCase()).filter(Boolean) : [];
  if (normalized.length === 0) return true;
  return normalized.some((value) => text.includes(value));
}

function containsAll(text, values) {
  const normalized = Array.isArray(values) ? values.map((value) => trimString(value).toLowerCase()).filter(Boolean) : [];
  if (normalized.length === 0) return true;
  return normalized.every((value) => text.includes(value));
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSource(source) {
  return {
    ...source,
    id: trimString(source?.id),
    name: trimString(source?.name) || trimString(source?.id),
    type: trimString(source?.type).toLowerCase(),
    target: trimString(source?.target),
    query: trimString(source?.query),
    url: trimString(source?.url),
    hl: trimString(source?.hl),
    gl: trimString(source?.gl),
    ceid: trimString(source?.ceid),
    baseWeight: toNumber(source?.baseWeight, 0),
    bootstrapHours: toNumber(source?.bootstrapHours, 0),
    lookbackHours: toNumber(source?.lookbackHours, DEFAULT_LOOKBACK_HOURS),
    maxItems: toNumber(source?.maxItems, DEFAULT_MAX_ITEMS),
    mustMatchAny: Array.isArray(source?.mustMatchAny) ? source.mustMatchAny : [],
    mustMatchAll: Array.isArray(source?.mustMatchAll) ? source.mustMatchAll : [],
    lowConfidence: Boolean(source?.lowConfidence),
  };
}

function compareItemsByRecency(left, right) {
  const leftTs = left?.publishedAt ? Date.parse(left.publishedAt) : 0;
  const rightTs = right?.publishedAt ? Date.parse(right.publishedAt) : 0;
  return rightTs - leftTs;
}

export function parseFeedItems(type, xml, source = {}) {
  const normalizedType = trimString(type).toLowerCase();
  if (normalizedType === 'atom') {
    const entries = [];
    for (const match of String(xml || '').matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
      const block = match[1];
      const title = normalizeWhitespace(decodeXmlEntities(extractTag(block, 'title')));
      if (!title) continue;
      const content = extractTag(block, 'content') || extractTag(block, 'summary');
      entries.push({
        title,
        headline: buildHeadline({ title }, source),
        link: trimString(extractAtomLink(block)),
        publishedAt: normalizeDate(extractTag(block, 'updated') || extractTag(block, 'published')),
        summary: stripHtml(content),
        publisher: normalizeWhitespace(trimString(source?.name)),
      });
    }
    return entries;
  }

  if (normalizedType === 'rss' || normalizedType === 'google_news_rss') {
    const items = [];
    for (const match of String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
      const block = match[1];
      const title = normalizeWhitespace(decodeXmlEntities(extractTag(block, 'title')));
      if (!title) continue;
      const sourceInfo = extractRssSource(block);
      const description = extractTag(block, 'description');
      items.push({
        title,
        headline: buildHeadline({ title }, source),
        link: trimString(decodeXmlEntities(extractTag(block, 'link'))),
        publishedAt: normalizeDate(extractTag(block, 'pubDate') || extractTag(block, 'updated')),
        summary: stripHtml(description),
        publisher: sourceInfo.name,
        publisherUrl: sourceInfo.url,
      });
    }
    return items;
  }

  throw new Error(`Unsupported source type: ${normalizedType || '(empty)'}`);
}

export function analyzeItem(item, source = {}) {
  const normalizedSource = normalizeSource(source);
  const text = normalizeWhitespace([
    item?.title,
    item?.summary,
    item?.publisher,
    item?.link,
    normalizedSource.name,
    normalizedSource.target,
  ].join(' ')).toLowerCase();

  if (!containsAny(text, normalizedSource.mustMatchAny)) {
    return {
      ...item,
      id: buildItemId(item, normalizedSource),
      headline: buildHeadline(item, normalizedSource),
      sourceId: normalizedSource.id,
      sourceName: normalizedSource.name,
      target: normalizedSource.target,
      score: 0,
      reasons: [],
      proposals: [],
      interesting: false,
      filtered: true,
    };
  }

  if (!containsAll(text, normalizedSource.mustMatchAll)) {
    return {
      ...item,
      id: buildItemId(item, normalizedSource),
      headline: buildHeadline(item, normalizedSource),
      sourceId: normalizedSource.id,
      sourceName: normalizedSource.name,
      target: normalizedSource.target,
      score: 0,
      reasons: [],
      proposals: [],
      interesting: false,
      filtered: true,
    };
  }

  let score = normalizedSource.baseWeight;
  const reasons = [];
  const proposals = [];
  const seenProposalKeys = new Set();

  if (normalizedSource.target === 'claude-code') {
    score += 2;
    reasons.push('direct Claude Code signal');
  } else if (normalizedSource.target === 'codex') {
    score += 1;
    reasons.push('adjacent Codex signal');
  } else if (normalizedSource.target === 'happy') {
    score += 2;
    reasons.push('direct Happy signal');
  }

  if (item?.publisher && /anthropic|openai|github/i.test(item.publisher)) {
    score += 1;
    reasons.push('official or platform-adjacent source');
  }

  for (const signal of SIGNALS) {
    if (!signal.patterns.some((pattern) => pattern.test(text))) continue;
    score += signal.score;
    reasons.push(signal.reason);
    if (!seenProposalKeys.has(signal.key)) {
      seenProposalKeys.add(signal.key);
      proposals.push(signal.proposal);
    }
  }

  const interestingThreshold = normalizedSource.lowConfidence ? LOW_CONFIDENCE_SCORE_THRESHOLD : INTERESTING_SCORE_THRESHOLD;
  const interesting = score >= interestingThreshold;

  return {
    ...item,
    id: buildItemId(item, normalizedSource),
    headline: buildHeadline(item, normalizedSource),
    sourceId: normalizedSource.id,
    sourceName: normalizedSource.name,
    target: normalizedSource.target,
    score,
    reasons,
    proposals,
    interesting,
    filtered: false,
  };
}

export function dedupeItems(items = []) {
  const deduped = new Map();

  for (const item of items) {
    const key = normalizeWhitespace(item?.headline || item?.title).toLowerCase();
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, item);
      continue;
    }
    const currentTs = item?.publishedAt ? Date.parse(item.publishedAt) : 0;
    const existingTs = existing?.publishedAt ? Date.parse(existing.publishedAt) : 0;
    if (item.score > existing.score || (item.score === existing.score && currentTs > existingTs)) {
      deduped.set(key, item);
    }
  }

  return [...deduped.values()];
}

export function summarizeProposals(items = []) {
  const counts = new Map();

  for (const item of items) {
    for (const proposal of item?.proposals || []) {
      counts.set(proposal, (counts.get(proposal) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([proposal, count]) => ({ proposal, count }))
    .sort((left, right) => right.count - left.count || left.proposal.localeCompare(right.proposal));
}

function truncate(value, maxLength) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatTimestamp(value) {
  const parsed = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) return value || 'unknown';
  return new Date(parsed).toISOString();
}

function buildSummaryJson({ startedAt, firstRun, sourceResults, allInteresting, pendingInteresting, reportPaths, notificationResult, sessionResult }) {
  return {
    startedAt,
    firstRun,
    sourcesChecked: sourceResults.length,
    sourceResults,
    interestingCount: allInteresting.length,
    pendingInterestingCount: pendingInteresting.length,
    proposals: summarizeProposals(pendingInteresting.length > 0 ? pendingInteresting : allInteresting).slice(0, 5),
    topSignals: (pendingInteresting.length > 0 ? pendingInteresting : allInteresting).slice(0, 5).map((item) => ({
      id: item.id,
      headline: item.headline,
      publishedAt: item.publishedAt,
      sourceName: item.sourceName,
      score: item.score,
      reasons: item.reasons,
      link: item.link,
    })),
    latestReportPath: reportPaths.latestMarkdownPath,
    latestJsonPath: reportPaths.latestJsonPath,
    session: sessionResult,
    notification: notificationResult,
  };
}

function renderReport({ startedAt, firstRun, sourceResults, allInteresting, pendingInteresting, latestSummaryPath, sessionResult }) {
  const focusItems = pendingInteresting.length > 0 ? pendingInteresting : allInteresting.slice(0, 5);
  const proposalSummary = summarizeProposals(focusItems);
  const lines = [
    '# Remote capability monitor',
    '',
    `- Run started: ${formatTimestamp(startedAt)}`,
    `- Run mode: ${firstRun ? 'bootstrap' : 'incremental'}`,
    `- Sources checked: ${sourceResults.length}`,
    `- New high-signal items: ${pendingInteresting.length}`,
    `- Total interesting items this cycle: ${allInteresting.length}`,
  ];

  if (latestSummaryPath) {
    lines.push(`- Latest JSON summary: ${latestSummaryPath}`);
  }

  if (sessionResult?.sessionId) {
    lines.push(`- Review session: ${sessionResult.sessionId}`);
    lines.push(`- Review session URL: ${sessionResult.sessionUrl}`);
    lines.push(`- Review run state: ${sessionResult.runState || 'unknown'}`);
  }

  const sourceErrors = sourceResults.filter((result) => result.error);
  if (sourceErrors.length > 0) {
    lines.push('');
    lines.push('## Source errors');
    lines.push('');
    for (const result of sourceErrors) {
      lines.push(`- ${result.sourceName}: ${result.error}`);
    }
  }

  lines.push('');
  lines.push('## Proposal shortlist');
  lines.push('');
  if (proposalSummary.length === 0) {
    lines.push('- No high-signal proposals surfaced in this cycle.');
  } else {
    for (const entry of proposalSummary.slice(0, 6)) {
      lines.push(`- ${entry.proposal} (${entry.count} signal${entry.count === 1 ? '' : 's'})`);
    }
  }

  lines.push('');
  lines.push('## Signals');
  lines.push('');
  if (focusItems.length === 0) {
    lines.push('- No interesting signals this cycle.');
  } else {
    for (const item of focusItems) {
      lines.push(`### ${item.headline}`);
      lines.push('');
      lines.push(`- Published: ${formatTimestamp(item.publishedAt)}`);
      lines.push(`- Source: ${item.sourceName}${item.publisher ? ` via ${item.publisher}` : ''}`);
      lines.push(`- Score: ${item.score}`);
      if (item.reasons.length > 0) {
        lines.push(`- Why it matters: ${item.reasons.join('; ')}`);
      }
      if (item.proposals.length > 0) {
        lines.push(`- Suggested moves: ${item.proposals.join(' | ')}`);
      }
      lines.push(`- Link: ${item.link || '(missing link)'}`);
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

async function fetchText(url) {
  const options = {
    headers: {
      'User-Agent': 'RemoteLab remote-capability-monitor/1.0',
      Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    },
  };

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    options.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status}) for ${url}`);
  }
  return response.text();
}

async function collectSourceItems(source, { firstRun, bootstrapHours }) {
  const url = buildSourceUrl(source);
  const xml = await fetchText(url);
  const parsedItems = parseFeedItems(source.type, xml, source).sort(compareItemsByRecency);
  const effectiveLookbackHours = firstRun
    ? (source.bootstrapHours || bootstrapHours)
    : (source.lookbackHours || DEFAULT_LOOKBACK_HOURS);
  const cutoff = Date.now() - (effectiveLookbackHours * 60 * 60 * 1000);

  const items = parsedItems
    .filter((item) => {
      if (!item.publishedAt) return true;
      const publishedMs = Date.parse(item.publishedAt);
      if (!Number.isFinite(publishedMs)) return true;
      return publishedMs >= cutoff;
    })
    .slice(0, source.maxItems || DEFAULT_MAX_ITEMS)
    .map((item) => ({
      ...item,
      sourceUrl: url,
    }));

  return {
    url,
    items,
  };
}

async function requestJson(baseUrl, pathname, { method = 'GET', cookie = '', body = undefined, redirect = 'follow' } = {}) {
  const headers = {
    Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
  };
  let payload;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(new URL(pathname, normalizeBaseUrl(baseUrl)).toString(), {
    method,
    headers,
    body: payload,
    redirect,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { response, text, json };
}

async function authenticateOwner(baseUrl, authFile) {
  const auth = await readJson(expandHome(authFile), null);
  const token = trimString(auth?.token);
  if (!token) {
    throw new Error(`Missing owner token in ${expandHome(authFile)}`);
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`, {
    method: 'GET',
    redirect: 'manual',
  });
  const sessionCookie = trimString(response.headers.get('set-cookie'))
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('session_token='));
  if (!sessionCookie) {
    throw new Error(`Owner auth failed (${response.status})`);
  }
  return sessionCookie;
}

async function loadAutomationAgent(baseUrl, agentId, cookie) {
  const result = await requestJson(baseUrl, '/api/agents', { cookie });
  if (!result.response.ok || !Array.isArray(result.json?.agents)) {
    throw new Error(result.json?.error || result.text || `Failed to load agents (${result.response.status})`);
  }
  return result.json.agents.find((agent) => agent?.id === agentId) || null;
}

function buildSessionDigestMessage({
  runAt,
  firstRun,
  pendingInteresting,
  allInteresting,
  sourceResults,
  reportPaths,
}) {
  const focusItems = pendingInteresting.length > 0 ? pendingInteresting : allInteresting.slice(0, 5);
  const proposalSummary = summarizeProposals(focusItems);
  const successfulSources = sourceResults.filter((result) => !result.error);
  const lines = [
    'Source: Remote capability monitor',
    `Cycle: ${formatTimestamp(runAt)}`,
    `Mode: ${firstRun ? 'bootstrap' : 'incremental'}`,
    'Focus: RemoteLab Live / remote control for local coding agents',
    '',
    'Tracked sources this cycle:',
  ];

  for (const result of successfulSources) {
    lines.push(`- ${result.sourceName} (${result.itemCount || 0} recent item${result.itemCount === 1 ? '' : 's'})`);
  }

  const failedSources = sourceResults.filter((result) => result.error);
  if (failedSources.length > 0) {
    lines.push('');
    lines.push('Source errors:');
    for (const result of failedSources) {
      lines.push(`- ${result.sourceName}: ${result.error}`);
    }
  }

  if (focusItems.length === 0) {
    lines.push('');
    lines.push('No new high-signal items in this cycle.');
  } else {
    lines.push('');
    lines.push(`New high-signal items: ${pendingInteresting.length}`);
    lines.push('');
    for (const item of focusItems.slice(0, 6)) {
      lines.push(`- ${item.headline}`);
      lines.push(`  source: ${item.sourceName}${item.publisher ? ` via ${item.publisher}` : ''}`);
      lines.push(`  published: ${formatTimestamp(item.publishedAt)}`);
      if (item.reasons.length > 0) lines.push(`  why: ${item.reasons.join('; ')}`);
      if (item.proposals.length > 0) lines.push(`  candidate moves: ${item.proposals.join(' | ')}`);
      lines.push(`  link: ${item.link || '(missing link)'}`);
    }
  }

  lines.push('');
  lines.push('Top proposal themes:');
  if (proposalSummary.length === 0) {
    lines.push('- none');
  } else {
    for (const proposal of proposalSummary.slice(0, 5)) {
      lines.push(`- ${proposal.proposal} (${proposal.count})`);
    }
  }

  lines.push('');
  lines.push('Artifacts:');
  lines.push(`- Markdown report: ${reportPaths.latestMarkdownPath}`);
  lines.push(`- JSON summary: ${reportPaths.latestJsonPath}`);
  lines.push('');
  lines.push('Please review this digest and respond with:');
  lines.push('1. Delta');
  lines.push('2. Why it matters for RemoteLab');
  lines.push('3. Proposal');
  lines.push('4. Ignore / watch');

  return `${lines.join('\n')}\n`;
}

async function waitForRunCompletion(baseUrl, runId, cookie) {
  const startedMs = Date.now();
  while (Date.now() - startedMs <= RUN_POLL_TIMEOUT_MS) {
    const result = await requestJson(baseUrl, `/api/runs/${runId}`, { cookie });
    if (!result.response.ok || !result.json?.run) {
      throw new Error(result.json?.error || result.text || `Failed to load run ${runId}`);
    }
    const run = result.json.run;
    if (['completed', 'failed', 'cancelled'].includes(run.state)) {
      return run;
    }
    await sleep(RUN_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for run ${runId}`);
}

async function submitDigestToRemoteLab(config, { runAt, firstRun, pendingInteresting, allInteresting, sourceResults, reportPaths, dryRun }) {
  const remoteConfig = config?.remotelab || {};
  const sessionConfig = remoteConfig?.session || {};
  const agentId = trimString(sessionConfig.agentId || sessionConfig.appId);
  if (!agentId) {
    return {
      success: false,
      skipped: true,
      reason: 'no_agent_configured',
    };
  }

  if (dryRun) {
    return {
      success: false,
      skipped: true,
      reason: 'dry_run',
      agentId,
    };
  }

  const baseUrl = normalizeBaseUrl(trimString(remoteConfig.baseUrl) || DEFAULT_REMOTELAB_BASE_URL);
  const authFile = trimString(remoteConfig.authFile) || DEFAULT_REMOTELAB_AUTH_FILE;
  const cookie = await authenticateOwner(baseUrl, authFile);
  const agent = await loadAutomationAgent(baseUrl, agentId, cookie);
  if (!agent) {
    throw new Error(`Agent not found for remote capability monitor: ${agentId}`);
  }

  const sessionPayload = {
    folder: expandHome(trimString(sessionConfig.folder) || trimString(remoteConfig.sessionFolder) || DEFAULT_REMOTELAB_SESSION_FOLDER),
    tool: trimString(sessionConfig.tool) || trimString(agent.tool) || trimString(remoteConfig.tool) || 'codex',
    name: trimString(sessionConfig.name) || trimString(agent.name) || 'Agent Radar',
    sourceId: 'automation',
    sourceName: 'Automation',
    templateId: agentId,
    templateName: trimString(agent.name),
    group: trimString(sessionConfig.group) || 'Automation',
    description: trimString(sessionConfig.description) || 'Scheduled scout for remote-control coding-agent capabilities and competitor changes.',
    systemPrompt: trimString(agent.systemPrompt) || trimString(sessionConfig.systemPrompt),
    externalTriggerId: trimString(sessionConfig.externalTriggerId) || `automation:${agentId}:remote-capability-monitor`,
  };

  const createResult = await requestJson(baseUrl, '/api/sessions', {
    method: 'POST',
    cookie,
    body: sessionPayload,
  });
  if (!createResult.response.ok || !createResult.json?.session?.id) {
    throw new Error(createResult.json?.error || createResult.text || `Failed to create session (${createResult.response.status})`);
  }

  const session = createResult.json.session;
  const requestSeed = pendingInteresting.map((item) => item.id).sort().join(',') || `heartbeat:${runAt}`;
  const requestId = `remote-capability-monitor:${createHash('sha1').update(`${requestSeed}:${runAt}`).digest('hex').slice(0, 16)}`;
  const messagePayload = {
    requestId,
    text: buildSessionDigestMessage({
      runAt,
      firstRun,
      pendingInteresting,
      allInteresting,
      sourceResults,
      reportPaths,
    }),
    tool: sessionPayload.tool,
  };
  if (typeof sessionConfig.thinking === 'boolean') messagePayload.thinking = sessionConfig.thinking;
  if (trimString(sessionConfig.model)) messagePayload.model = trimString(sessionConfig.model);
  if (trimString(sessionConfig.effort)) messagePayload.effort = trimString(sessionConfig.effort);

  const submitResult = await requestJson(baseUrl, `/api/sessions/${session.id}/messages`, {
    method: 'POST',
    cookie,
    body: messagePayload,
  });
  if (![200, 202].includes(submitResult.response.status) || !submitResult.json?.run?.id) {
    throw new Error(submitResult.json?.error || submitResult.text || `Failed to submit digest message (${submitResult.response.status})`);
  }

  const run = await waitForRunCompletion(baseUrl, submitResult.json.run.id, cookie);

  return {
    success: run.state === 'completed',
    agentId,
    appName: trimString(app.name),
    sessionId: session.id,
    runId: submitResult.json.run.id,
    requestId,
    runState: run.state,
    duplicate: submitResult.json?.duplicate === true,
    sessionUrl: buildSessionUrl(session.id),
  };
}

function touchObservedItem(state, item, runAt) {
  const existing = state.observedItems[item.id] || {};
  state.observedItems[item.id] = {
    id: item.id,
    headline: item.headline,
    link: item.link,
    sourceName: item.sourceName,
    target: item.target,
    score: item.score,
    firstSeenAt: existing.firstSeenAt || runAt,
    lastSeenAt: runAt,
    publishedAt: item.publishedAt || existing.publishedAt || '',
  };
}

function markItemsNotified(state, items, { notificationId, reportPath }, runAt) {
  for (const item of items) {
    state.notifiedItems[item.id] = {
      id: item.id,
      headline: item.headline,
      notificationId,
      reportPath,
      notifiedAt: runAt,
    };
  }
}

function pruneStateIndex(index, timestampKey, cutoffMs) {
  const pruned = {};
  for (const [key, value] of Object.entries(index || {})) {
    const timestamp = Date.parse(value?.[timestampKey] || '');
    if (Number.isFinite(timestamp) && timestamp >= cutoffMs) {
      pruned[key] = value;
    }
  }
  return pruned;
}

function buildNotificationMessage({ pendingInteresting, allInteresting, reportPaths, firstRun, sessionResult }) {
  const proposalSummary = summarizeProposals(pendingInteresting.length > 0 ? pendingInteresting : allInteresting);
  const focusItems = pendingInteresting.length > 0 ? pendingInteresting : allInteresting.slice(0, 3);
  const sessionUrl = trimString(sessionResult?.sessionUrl);

  if (pendingInteresting.length === 0) {
    const noSignalTitle = sessionResult?.success
      ? `${sessionResult.appName || 'Agent Radar'}: review refreshed`
      : 'RemoteLab scout: no new signals';
    const noSignalBody = sessionResult?.success
      ? 'No new signals; the review session was refreshed.'
      : 'No new high-signal remote-agent changes in this cycle.';
    return {
      title: noSignalTitle,
      body: noSignalBody,
      text: [
        `RemoteLab scout completed an ${firstRun ? 'initial bootstrap' : 'incremental'} cycle and found no new high-signal items.`,
        '',
        ...(sessionResult?.success ? [
          `Review session: ${sessionResult.appName || 'Agent Radar'} (${sessionResult.sessionId})`,
          `Deep link: ${sessionResult.sessionUrl}`,
          '',
        ] : []),
        `Latest report: ${reportPaths.latestMarkdownPath}`,
      ].join('\n'),
      proposalSummary,
      focusItems,
      url: sessionUrl || '/?tab=sessions',
    };
  }

  const title = sessionResult?.success
    ? `Agent Radar: ${pendingInteresting.length} new signal${pendingInteresting.length === 1 ? '' : 's'} ready`
    : `RemoteLab scout: ${pendingInteresting.length} new signal${pendingInteresting.length === 1 ? '' : 's'}`;
  const firstHeadline = truncate(focusItems[0]?.headline || 'New remote-agent signal', 72);
  const body = sessionResult?.success
    ? `Review is ready in ${sessionResult.appName || 'the scout session'}`
    : (pendingInteresting.length === 1 ? firstHeadline : `${firstHeadline}; +${pendingInteresting.length - 1} more`);
  const lines = [
    `RemoteLab scout found ${pendingInteresting.length} new high-signal item${pendingInteresting.length === 1 ? '' : 's'}.`,
    '',
    'Top proposals:',
  ];

  for (const proposal of proposalSummary.slice(0, 4)) {
    lines.push(`- ${proposal.proposal} (${proposal.count})`);
  }

  lines.push('');
  lines.push('Signals:');
  for (const item of focusItems.slice(0, 4)) {
    lines.push(`- ${item.headline}`);
  }
  lines.push('');
  if (sessionResult?.success) {
    lines.push(`Review session: ${sessionResult.appName || 'Agent Radar'} (${sessionResult.sessionId})`);
    lines.push(`Deep link: ${sessionResult.sessionUrl}`);
    lines.push('');
  }
  lines.push(`Latest report: ${reportPaths.latestMarkdownPath}`);

  return {
    title,
    body,
    text: lines.join('\n'),
    proposalSummary,
    focusItems,
    url: sessionUrl || '/?tab=sessions',
  };
}

function materializeNotificationChannels(channelTemplates, message) {
  return (Array.isArray(channelTemplates) ? channelTemplates : []).map((channel) => {
    const type = trimString(channel?.type).toLowerCase();
    const next = { ...channel };
    if (type === 'feishu') {
      next.text = truncate(trimString(channel?.text) || message.text, 900);
    } else if (type === 'email') {
      next.subject = trimString(channel?.subject) || message.title;
      next.text = trimString(channel?.text) || message.text;
    } else if (type === 'remotelab_web_push') {
      next.title = trimString(channel?.title) || message.title;
      next.body = trimString(channel?.body) || message.body;
      next.url = trimString(message?.url) || trimString(channel?.url) || '/?tab=sessions';
    } else if (type === 'mac_notification') {
      next.title = trimString(channel?.title) || message.title;
      next.body = trimString(channel?.body) || message.body;
    }
    return next;
  });
}

async function runNotifier(notifierPath, configPath, dryRun) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [notifierPath, configPath, ...(dryRun ? ['--dry-run'] : [])], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ ok: true, stdout, stderr });
        return;
      }
      rejectPromise(new Error(stderr.trim() || stdout.trim() || `Notifier exited with code ${code}`));
    });
  });
}

async function sendDigestNotification(config, message, itemIds, reportPaths, dryRun) {
  const notificationConfig = config?.notification || {};
  const channels = materializeNotificationChannels(notificationConfig.channels, message);
  if (channels.length === 0) {
    return {
      success: false,
      skipped: true,
      reason: 'no_channels_configured',
    };
  }

  const notifierPath = expandHome(trimString(notificationConfig.notifierPath) || DEFAULT_NOTIFIER_PATH);
  const digestHash = createHash('sha1').update(itemIds.sort().join(',') || `heartbeat:${reportPaths.latestMarkdownPath}`).digest('hex').slice(0, 12);
  const notificationId = `remote-capability-monitor-${digestHash}`;
  const configPath = join(DEFAULT_NOTIFICATION_DIR, 'requests', `${notificationId}.json`);
  const markerPath = join(DEFAULT_NOTIFICATION_DIR, 'markers', `${notificationId}.json`);

  await writeJson(configPath, {
    id: notificationId,
    title: message.title,
    body: message.body,
    markerPath,
    logPath: DEFAULT_NOTIFICATION_LOG,
    channels,
  });

  const result = await runNotifier(notifierPath, configPath, dryRun);
  return {
    success: true,
    notificationId,
    configPath,
    stdout: result.stdout.trim(),
  };
}

function initialState() {
  return {
    version: 1,
    initializedAt: '',
    lastRunAt: '',
    lastReportPath: '',
    observedItems: {},
    notifiedItems: {},
  };
}

async function writeReports(reportDir, markdown, summaryJson) {
  const timestamp = new Date(summaryJson.startedAt || Date.now()).toISOString().replace(/[:]/g, '-');
  const day = timestamp.slice(0, 10);
  const dayDir = join(reportDir, 'reports', day);
  const markdownPath = join(dayDir, `${timestamp}.md`);
  const jsonPath = join(dayDir, `${timestamp}.json`);
  const latestMarkdownPath = join(reportDir, 'latest.md');
  const latestJsonPath = join(reportDir, 'latest.json');

  await writeText(markdownPath, markdown);
  await writeJson(jsonPath, summaryJson);
  await writeText(latestMarkdownPath, markdown);
  await writeJson(latestJsonPath, summaryJson);

  return {
    markdownPath,
    jsonPath,
    latestMarkdownPath,
    latestJsonPath,
  };
}

export async function runMonitor(rawOptions) {
  const options = rawOptions || parseArgs(process.argv.slice(2));
  const configPath = expandHome(options.configPath || DEFAULT_CONFIG_PATH);
  const config = await readJson(configPath, null);
  if (!config) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const statePath = expandHome(options.stateFile || trimString(config.statePath) || DEFAULT_STATE_PATH);
  const reportDir = expandHome(options.reportDir || trimString(config.reportDir) || DEFAULT_REPORT_DIR);
  const bootstrapHours = options.bootstrapHours || toNumber(config.bootstrapHours, DEFAULT_BOOTSTRAP_HOURS);
  const state = (await readJson(statePath, null)) || initialState();
  const firstRun = !trimString(state.initializedAt);
  const runAt = new Date().toISOString();
  const sources = (Array.isArray(config.sources) ? config.sources : []).map(normalizeSource).filter((source) => source.id && source.type);
  if (sources.length === 0) {
    throw new Error('Config contains no valid sources');
  }

  const sourceResults = [];
  const analyzedItems = [];

  for (const source of sources) {
    try {
      const collected = await collectSourceItems(source, { firstRun, bootstrapHours });
      sourceResults.push({
        sourceId: source.id,
        sourceName: source.name,
        url: collected.url,
        itemCount: collected.items.length,
      });
      if (options.verbose) {
        console.error(`[monitor] ${source.id}: ${collected.items.length} items`);
      }
      for (const item of collected.items) {
        const analyzed = analyzeItem(item, source);
        if (!analyzed.filtered) analyzedItems.push(analyzed);
      }
    } catch (error) {
      sourceResults.push({
        sourceId: source.id,
        sourceName: source.name,
        error: error?.message || String(error),
      });
      if (options.verbose) {
        console.error(`[monitor] ${source.id}: ${error?.message || String(error)}`);
      }
    }
  }

  const dedupedItems = dedupeItems(analyzedItems).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return compareItemsByRecency(left, right);
  });
  const allInteresting = dedupedItems.filter((item) => item.interesting);
  const pendingInteresting = allInteresting.filter((item) => !state.notifiedItems[item.id]);

  const provisionalSummary = buildSummaryJson({
    startedAt: runAt,
    firstRun,
    sourceResults,
    allInteresting,
    pendingInteresting,
    reportPaths: {
      latestMarkdownPath: join(reportDir, 'latest.md'),
      latestJsonPath: join(reportDir, 'latest.json'),
    },
    sessionResult: null,
    notificationResult: null,
  });
  const markdown = renderReport({
    startedAt: runAt,
    firstRun,
    sourceResults,
    allInteresting,
    pendingInteresting,
    latestSummaryPath: join(reportDir, 'latest.json'),
    sessionResult: null,
  });
  const reportPaths = await writeReports(reportDir, markdown, provisionalSummary);
  let sessionResult = {
    success: false,
    skipped: pendingInteresting.length === 0 && !options.forceNotify,
    reason: pendingInteresting.length === 0 && !options.forceNotify ? 'no_new_signals' : '',
  };

  if (pendingInteresting.length > 0 || options.forceNotify) {
    sessionResult = await submitDigestToRemoteLab(config, {
      runAt,
      firstRun,
      pendingInteresting,
      allInteresting,
      sourceResults,
      reportPaths,
      dryRun: options.dryRun,
    });
  }

  const message = buildNotificationMessage({ pendingInteresting, allInteresting, reportPaths, firstRun, sessionResult });

  let notificationResult = {
    success: false,
    skipped: pendingInteresting.length === 0 && !options.forceNotify,
    reason: pendingInteresting.length === 0 && !options.forceNotify ? 'no_new_signals' : '',
  };

  const shouldSendNotification = options.forceNotify || (!sessionResult.success && pendingInteresting.length > 0);

  if (sessionResult.success && pendingInteresting.length > 0 && !options.forceNotify) {
    notificationResult = {
      success: false,
      skipped: true,
      reason: 'session_delivery_primary',
    };
  } else if (shouldSendNotification) {
    notificationResult = await sendDigestNotification(
      config,
      message,
      pendingInteresting.map((item) => item.id),
      reportPaths,
      options.dryRun,
    );
  }

  const finalMarkdown = renderReport({
    startedAt: runAt,
    firstRun,
    sourceResults,
    allInteresting,
    pendingInteresting,
    latestSummaryPath: reportPaths.latestJsonPath,
    sessionResult,
  });
  await writeText(reportPaths.markdownPath, finalMarkdown);
  await writeText(reportPaths.latestMarkdownPath, finalMarkdown);

  const finalSummary = buildSummaryJson({
    startedAt: runAt,
    firstRun,
    sourceResults,
    allInteresting,
    pendingInteresting,
    reportPaths,
    sessionResult,
    notificationResult,
  });
  await writeJson(reportPaths.jsonPath, finalSummary);
  await writeJson(reportPaths.latestJsonPath, finalSummary);

  if (!options.dryRun) {
    for (const item of dedupedItems) {
      touchObservedItem(state, item, runAt);
    }
    if (firstRun) {
      state.initializedAt = runAt;
    }
    state.lastRunAt = runAt;
    state.lastReportPath = reportPaths.latestMarkdownPath;

    if ((sessionResult.success || notificationResult.success) && pendingInteresting.length > 0) {
      markItemsNotified(state, pendingInteresting, {
        notificationId: sessionResult.runId || notificationResult.notificationId || 'session-delivered',
        reportPath: reportPaths.latestMarkdownPath,
      }, runAt);
    }

    const cutoffMs = Date.now() - (STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    state.observedItems = pruneStateIndex(state.observedItems, 'lastSeenAt', cutoffMs);
    state.notifiedItems = pruneStateIndex(state.notifiedItems, 'notifiedAt', cutoffMs);
    await writeJson(statePath, state);
  }

  console.log(JSON.stringify(finalSummary, null, 2));

  const failedSources = sourceResults.filter((result) => result.error);
  if (!options.dryRun && pendingInteresting.length > 0 && !sessionResult.success && !notificationResult.success) {
    process.exitCode = 1;
  } else if (failedSources.length === sourceResults.length) {
    process.exitCode = 1;
  }

  return finalSummary;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  runMonitor().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
