#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

import { findPerson, loadAuthDocument } from '../lib/auth-config.mjs';
import { createRemoteLabHttpClient } from '../lib/remotelab-http-client.mjs';
import { createSerialTaskQueue, readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';
import { emptySignalStore, makeStatusSnapshot, replaceSource, selectOfficialScene, validateSourcePacket } from './status-state.mjs';
import { remotelabStatusSource } from './remotelab-status-source.mjs';
import { normalizeSentence, prepareContent, renderPersonalPng } from './personal-content.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const bindHost = String(process.env.REMOTELAB_DISPLAY_BIND_HOST || '127.0.0.1').trim();
const listenPort = Number.parseInt(process.env.REMOTELAB_DISPLAY_PORT || '8792', 10);
const publicBaseUrl = String(process.env.REMOTELAB_DISPLAY_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const configDir = process.env.REMOTELAB_CONFIG_DIR
  || join(homedir(), '.config', 'remotelab');
const stateFile = process.env.REMOTELAB_DISPLAY_STATE_FILE
  || join(configDir, 'display-devices.json');
const adminTokenFile = process.env.REMOTELAB_DISPLAY_ADMIN_TOKEN_FILE
  || join(configDir, 'display-admin-token');
const signalFile = process.env.REMOTELAB_DISPLAY_SIGNAL_FILE || join(configDir, 'display-signals.json');
const personalFile = process.env.REMOTELAB_DISPLAY_PERSONAL_FILE || join(configDir, 'display-personal-content.json');
const previewFile = process.env.REMOTELAB_DISPLAY_PREVIEW_FILE || join(configDir, 'display-preview-frames.json');
const renderMode = process.env.REMOTELAB_DISPLAY_RENDER_MODE || 'classic';
if (!['classic', 'signals'].includes(renderMode)) throw new Error('Unknown display render mode');
const themeUrl = process.env.REMOTELAB_DISPLAY_THEME_MODULE
  ? pathToFileURL(resolve(process.env.REMOTELAB_DISPLAY_THEME_MODULE)).href
  : new URL('./themes/official.mjs', import.meta.url).href;
const theme = await import(themeUrl);
if (typeof theme.renderTheme !== 'function') throw new TypeError('Display theme must export renderTheme(snapshot, context)');
const enrollmentTtlMs = 10 * 60 * 1000;
const saveState = createSerialTaskQueue();
const saveSignals = createSerialTaskQueue();
const savePersonal = createSerialTaskQueue();
const savePreview = createSerialTaskQueue();
let personalStorePromise;
const preparedPersonal = new Map();
const client = createRemoteLabHttpClient({
  baseUrl: process.env.REMOTELAB_CHAT_BASE_URL || 'http://127.0.0.1:7690',
});

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function tokenHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function newToken(prefix) {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

async function ensureAdminToken() {
  try {
    const existing = trimString(await readFile(adminTokenFile, 'utf8'));
    if (existing) return existing;
  } catch {}
  const token = newToken('rld_admin');
  await mkdir(dirname(adminTokenFile), { recursive: true });
  await writeFile(adminTokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(adminTokenFile, 0o600);
  return token;
}

function normalizeState(value) {
  const state = value && typeof value === 'object' ? value : {};
  return {
    version: 1,
    enrollments: Array.isArray(state.enrollments) ? state.enrollments : [],
    devices: Array.isArray(state.devices) ? state.devices : [],
  };
}

async function loadState() {
  return normalizeState(await readJson(stateFile, null));
}

async function updateState(mutator) {
  return saveState(async () => {
    const current = await loadState();
    const result = await mutator(current);
    await writeJsonAtomic(stateFile, current);
    await chmod(stateFile, 0o600);
    return result;
  });
}

async function loadSignalStore() {
  let raw;
  try {
    raw = await readFile(signalFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptySignalStore();
    throw error;
  }
  const store = JSON.parse(raw);
  if (store?.schemaVersion !== 1 || !store.people || typeof store.people !== 'object' || Array.isArray(store.people)) {
    throw new Error('Invalid display signal store');
  }
  return store;
}

async function updateSignalStore(mutator) {
  return saveSignals(async () => {
    const result = await mutator(await loadSignalStore());
    if (result.changed) {
      await writeJsonAtomic(signalFile, result.store);
      await chmod(signalFile, 0o600);
    }
    return result;
  });
}

async function loadPersonalStore() {
  if (!personalStorePromise) personalStorePromise = readJson(personalFile, { version: 1, people: {} });
  try {
    return await personalStorePromise;
  } catch (error) {
    personalStorePromise = null;
    throw error;
  }
}

async function personalFor(personId) {
  const entry = (await loadPersonalStore()).people?.[personId];
  if (!entry) return null;
  const cached = preparedPersonal.get(personId);
  if (cached?.updatedAt === entry.updatedAt) return cached.content;
  const content = prepareContent(entry);
  preparedPersonal.set(personId, { updatedAt: entry.updatedAt, content });
  return content;
}

async function updatePersonal(personId, entry) {
  return savePersonal(async () => {
    const current = await loadPersonalStore();
    const people = { ...current.people };
    if (entry) people[personId] = entry;
    else delete people[personId];
    const next = { version: 1, people };
    await writeJsonAtomic(personalFile, next);
    await chmod(personalFile, 0o600);
    personalStorePromise = Promise.resolve(next);
    preparedPersonal.delete(personId);
  });
}

async function previewFor(personId) {
  const entry = (await readJson(previewFile, { version: 1, people: {} })).people?.[personId];
  if (!entry || Date.parse(entry.expiresAt) <= Date.now()) return null;
  return entry;
}

async function updatePreview(personId, entry) {
  return savePreview(async () => {
    const current = await readJson(previewFile, { version: 1, people: {} });
    const people = { ...current.people };
    if (entry) people[personId] = entry;
    else delete people[personId];
    await writeJsonAtomic(previewFile, { version: 1, people });
    await chmod(previewFile, 0o600);
  });
}

function requestOrigin(req) {
  if (publicBaseUrl) return publicBaseUrl;
  const forwardedProto = trimString(req.headers['x-forwarded-proto']).split(',')[0] || 'http';
  const forwardedHost = trimString(req.headers['x-forwarded-host']).split(',')[0];
  const host = forwardedHost || trimString(req.headers.host);
  const forwardedPrefix = trimString(req.headers['x-forwarded-prefix']).split(',')[0];
  const prefix = /^\/[A-Za-z0-9/_-]*$/.test(forwardedPrefix)
    ? forwardedPrefix.replace(/\/+$/, '')
    : '';
  return host ? `${forwardedProto}://${host}${prefix}` : `http://${bindHost}:${listenPort}${prefix}`;
}

function sendJson(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function sendText(res, status, contentType, body, headers = {}) {
  const encoded = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': encoded.length,
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(encoded);
}

async function readRequestJson(req, maxBytes = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function adminCredential(req, url) {
  const bearer = trimString(req.headers.authorization).replace(/^Bearer\s+/i, '');
  return bearer || trimString(url.searchParams.get('admin'));
}

async function requireAdmin(req, res, url) {
  const expected = await ensureAdminToken();
  if (secureEqual(adminCredential(req, url), expected)) return true;
  sendJson(res, 401, { error: 'Display administrator authentication required' });
  return false;
}

function deviceCredential(req) {
  return trimString(req.headers.authorization).replace(/^Bearer\s+/i, '');
}

async function authenticateDevice(req, deviceId) {
  const suppliedHash = tokenHash(deviceCredential(req));
  const state = await loadState();
  return state.devices.find((device) => (
    device.id === deviceId
    && !device.revokedAt
    && secureEqual(device.tokenHash, suppliedHash)
  )) || null;
}

function timestampMs(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function getPersonIdentityIds(personId) {
  const document = await loadAuthDocument({ persistMigration: true });
  const person = findPerson(document, personId);
  if (!person) throw Object.assign(new Error('Display owner no longer exists'), { status: 410 });
  return new Set((person.identities || []).map((identity) => trimString(identity.id)).filter(Boolean));
}

async function collectSnapshot(personId) {
  const identityIds = await getPersonIdentityIds(personId);
  const result = await client.request('/api/sessions');
  if (!result.response.ok || !Array.isArray(result.json?.sessions)) {
    throw new Error(result.json?.error || result.text || 'RemoteLab sessions unavailable');
  }
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  let running = 0;
  let queued = 0;
  let pendingReview = 0;
  let deliveryIssues = 0;
  const active = [];
  for (const session of result.json.sessions) {
    if (!identityIds.has(trimString(session?.initiatedByIdentityId))) continue;
    const run = session?.activity?.run || {};
    const queueCount = Number(session?.activity?.queue?.count || 0);
    if (run.state === 'running') {
      running += 1;
      if (active.length < 3) {
        active.push({
          name: trimString(session.name) || '未命名 Session',
          startedAt: trimString(run.startedAt),
          source: trimString(session?.conversation?.connector || session.sourceName) || 'RemoteLab',
        });
      }
    }
    queued += Math.max(0, queueCount);
    const assistantAt = timestampMs(session.lastAssistantMessageAt);
    const reviewedAt = timestampMs(session.lastReviewedAt);
    if (run.state !== 'running' && assistantAt >= cutoff && assistantAt > reviewedAt) {
      pendingReview += 1;
    }
    const latestAt = Math.max(timestampMs(session.lastEventAt), timestampMs(session.updatedAt));
    if (latestAt >= cutoff) deliveryIssues += Number(session.deliveryIssueCount || 0);
  }
  return { running, queued, pendingReview, deliveryIssues, active, observedAt: new Date().toISOString() };
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shortText(value, max = 24) {
  const text = trimString(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function elapsedLabel(value) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestampMs(value)) / 60000));
  if (!timestampMs(value) || elapsedMinutes < 1) return '<1 分钟';
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟`;
  return `${Math.floor(elapsedMinutes / 60)} 小时 ${elapsedMinutes % 60} 分`;
}

function snapshotSvg(snapshot) {
  const now = new Date();
  const notices = [];
  if (snapshot.deliveryIssues) notices.push(['#ff7272', '消息投递异常', `${snapshot.deliveryIssues} 条需要检查`]);
  if (snapshot.queued) notices.push(['#89a8ff', '请求正在排队', `队列中还有 ${snapshot.queued} 项`]);
  if (snapshot.pendingReview) notices.push(['#f5c86b', '结果等待 Review', `近 24 小时共 ${snapshot.pendingReview} 项`]);
  if (!notices.length) notices.push(['#56e0b4', '运行平稳', '当前没有关键提醒']);
  const activeRows = snapshot.active.length
    ? snapshot.active.map((item, index) => {
      const y = 171 + index * 78;
      return `<circle cx="450" cy="${y}" r="5" fill="#56e0b4"/>
        <text x="470" y="${y + 8}" class="row">${escapeXml(shortText(item.name, 30))}</text>
        <text x="470" y="${y + 35}" class="small muted">${escapeXml(item.source.toUpperCase())}</text>
        <text x="1145" y="${y + 8}" text-anchor="end" class="body muted">${escapeXml(elapsedLabel(item.startedAt))}</text>`;
    }).join('')
    : '<text x="444" y="220" class="row muted">当前没有正在执行的 Session</text>';
  const noticeRows = notices.slice(0, 3).map((item, index) => {
    const y = 165 + index * 78;
    return `<rect x="1224" y="${y - 7}" width="8" height="48" rx="4" fill="${item[0]}"/>
      <text x="1252" y="${y + 8}" class="row">${escapeXml(item[1])}</text>
      <text x="1252" y="${y + 36}" class="body muted">${escapeXml(item[2])}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="480" viewBox="0 0 1920 480">
    <style>
      text { font-family: "Noto Sans CJK SC", "PingFang SC", sans-serif; fill: #ecf2f5; }
      .brand { font-size: 25px; font-weight: 700; }
      .clock { font-size: 31px; font-weight: 700; }
      .section { font-size: 19px; font-weight: 600; fill: #8fa0aa; }
      .metric { font-size: 69px; font-weight: 700; }
      .label { font-size: 19px; font-weight: 600; }
      .row { font-size: 24px; font-weight: 600; }
      .body { font-size: 19px; }
      .small { font-size: 16px; }
      .muted { fill: #758690; }
    </style>
    <rect width="1920" height="480" fill="#0b0f13"/>
    <text x="42" y="47" class="brand">MUKA</text><text x="130" y="47" class="body muted">REMOTELAB OPS</text>
    <circle cx="1484" cy="36" r="6" fill="#56e0b4"/><text x="1502" y="43" class="body" fill="#56e0b4">LIVE</text>
    <text x="1658" y="45" class="clock">${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</text>
    <text x="1780" y="43" class="small muted">${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}</text>
    <path d="M42 69H1878" stroke="#243039"/>
    <rect x="42" y="88" width="356" height="322" rx="20" fill="#111820" stroke="#243039" stroke-width="2"/>
    <text x="66" y="132" class="section">运行概览</text>
    <text x="66" y="235" class="metric" fill="#56e0b4">${snapshot.running}</text><text x="66" y="260" class="label">运行中</text>
    <text x="230" y="235" class="metric" fill="#f5c86b">${snapshot.pendingReview}</text><text x="230" y="260" class="label">待 REVIEW</text>
    <path d="M66 280H374" stroke="#243039"/>
    <rect x="66" y="302" width="140" height="72" rx="13" fill="#18222c"/><text x="80" y="329" class="small muted">队列</text><text x="80" y="359" class="label" fill="#89a8ff">${snapshot.queued}</text>
    <rect x="218" y="302" width="156" height="72" rx="13" fill="#18222c"/><text x="232" y="329" class="small muted">近期异常</text><text x="232" y="359" class="label" fill="#ff7272">${snapshot.deliveryIssues}</text>
    <rect x="418" y="88" width="760" height="322" rx="20" fill="#111820" stroke="#243039" stroke-width="2"/>
    <text x="444" y="132" class="section">正在执行</text><text x="1145" y="132" text-anchor="end" class="small" fill="#56e0b4">${snapshot.running} ACTIVE</text>
    ${activeRows}
    <rect x="1198" y="88" width="680" height="322" rx="20" fill="#111820" stroke="#243039" stroke-width="2"/>
    <text x="1224" y="132" class="section">关键通知</text>${noticeRows}
    <text x="46" y="458" class="small muted">REMOTELAB  刚刚</text><text x="1530" y="458" class="small muted">由当前 RemoteLab Server 提供</text>
  </svg>`;
}

async function renderFrame(personId) {
  const preview = await previewFor(personId);
  if (preview) {
    await getPersonIdentityIds(personId);
    return { png: Buffer.from(preview.pngBase64, 'base64'), snapshot: { observedAt: preview.updatedAt }, pollSeconds: 1 };
  }
  const personal = await personalFor(personId);
  if (personal) {
    await getPersonIdentityIds(personId);
    return {
      png: renderPersonalPng(personal),
      snapshot: { observedAt: new Date().toISOString() },
      pollSeconds: 0.45,
    };
  }
  if (renderMode === 'signals') return renderSignalFrame(personId);
  const snapshot = await collectSnapshot(personId);
  const renderer = new Resvg(snapshotSvg(snapshot), {
    background: '#0b0f13',
    font: { loadSystemFonts: true, defaultFontFamily: 'sans-serif' },
  });
  return { png: Buffer.from(renderer.render().asPng()), snapshot, pollSeconds: 8 };
}

async function collectStatusView(personId) {
  await getPersonIdentityIds(personId);
  let metrics = null;
  try {
    metrics = await collectSnapshot(personId);
  } catch (error) {
    if (error.status === 410) throw error;
    console.error('[display] RemoteLab source unavailable:', error.message);
  }
  const nowMs = Date.now();
  const store = await loadSignalStore();
  const sourcePackets = { ...store.people?.[personId] };
  if (metrics) sourcePackets.remotelab = validateSourcePacket(remotelabStatusSource(metrics, nowMs), nowMs);
  else sourcePackets.remotelab = {
    schemaVersion: 1, sequence: nowMs, label: 'RemoteLab',
    observedAt: new Date(nowMs - 60_000).toISOString(),
    validUntil: new Date(nowMs - 1).toISOString(), signals: [],
  };
  const snapshot = makeStatusSnapshot(sourcePackets, nowMs);
  return { snapshot, scene: selectOfficialScene(snapshot, nowMs), metrics, nowMs };
}

async function renderSignalFrame(personId) {
  const view = await collectStatusView(personId);
  return { png: renderStatusPng(view), snapshot: view.metrics || { observedAt: view.snapshot.generatedAt }, view, pollSeconds: 8 };
}

function renderStatusPng(view) {
  const svg = theme.renderTheme(view.snapshot, { metrics: view.metrics, nowMs: view.nowMs });
  if (typeof svg !== 'string') throw new TypeError('Display theme must return an SVG string');
  const renderer = new Resvg(svg, {
    background: '#0b1118',
    font: { loadSystemFonts: true, defaultFontFamily: 'sans-serif' },
  });
  const rendered = renderer.render();
  if (rendered.width !== 1920 || rendered.height !== 480) {
    throw new TypeError('Display theme must render at 1920 × 480');
  }
  return Buffer.from(rendered.asPng());
}

async function handle(req, res) {
  const url = new URL(req.url, requestOrigin(req));
  const pathname = url.pathname;
  if (pathname === '/healthz' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, service: 'remotelab-display', version: 1 });
    return;
  }
  if (pathname === '/install.sh' && req.method === 'GET') {
    sendText(res, 200, 'text/x-shellscript; charset=utf-8', await readFile(join(moduleDir, 'install.sh')));
    return;
  }
  if (pathname === '/agent.py' && req.method === 'GET') {
    sendText(res, 200, 'text/x-python; charset=utf-8', await readFile(join(moduleDir, 'agent.py')));
    return;
  }
  const previewMatch = /^\/v1\/people\/([^/]+)\/preview-frame$/.exec(pathname);
  if (previewMatch && ['GET', 'PUT', 'DELETE'].includes(req.method)) {
    if (!await requireAdmin(req, res, url)) return;
    const personId = decodeURIComponent(previewMatch[1]);
    await getPersonIdentityIds(personId);
    if (req.method === 'GET') {
      const entry = await previewFor(personId);
      sendJson(res, 200, entry ? { configured: true, frameId: entry.frameId, updatedAt: entry.updatedAt, expiresAt: entry.expiresAt } : { configured: false });
      return;
    }
    if (req.method === 'DELETE') {
      await updatePreview(personId, null);
      sendJson(res, 200, { configured: false });
      return;
    }
    const payload = await readRequestJson(req, 9 * 1024 * 1024);
    if (typeof payload.pngBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.pngBase64) || payload.pngBase64.length > 8 * 1024 * 1024) throw Object.assign(new Error('Invalid preview PNG'), { status: 400 });
    const png = Buffer.from(payload.pngBase64, 'base64');
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== 1920 || png.readUInt32BE(20) !== 480) throw Object.assign(new Error('Preview must be 1920 x 480 PNG'), { status: 400 });
    const frameId = createHash('sha256').update(png).digest('hex').slice(0, 12);
    const updatedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await updatePreview(personId, { pngBase64: payload.pngBase64, frameId, updatedAt, expiresAt });
    sendJson(res, 200, { configured: true, frameId, updatedAt, expiresAt });
    return;
  }
  const personStatusMatch = /^\/v1\/people\/([^/]+)\/(status|preview\.png|content|content\.gif)$/.exec(pathname);
  if (personStatusMatch && req.method === 'GET') {
    if (!await requireAdmin(req, res, url)) return;
    const personId = decodeURIComponent(personStatusMatch[1]);
    await getPersonIdentityIds(personId);
    if (personStatusMatch[2] === 'content' || personStatusMatch[2] === 'content.gif') {
      const entry = (await loadPersonalStore()).people?.[personId];
      if (personStatusMatch[2] === 'content') {
        sendJson(res, 200, entry
          ? { configured: true, sentence: entry.sentence, updatedAt: entry.updatedAt, animation: true }
          : { configured: false, sentence: '', animation: false });
      } else if (entry) sendText(res, 200, 'image/gif', Buffer.from(entry.gifBase64, 'base64'));
      else sendJson(res, 404, { error: 'No GIF configured' });
      return;
    }
    if (personStatusMatch[2] === 'preview.png') {
      const personal = await personalFor(personId);
      if (personal) { sendText(res, 200, 'image/png', renderPersonalPng(personal)); return; }
    }
    const view = await collectStatusView(personId);
    if (personStatusMatch[2] === 'status') sendJson(res, 200, { snapshot: view.snapshot, scene: view.scene, metrics: view.metrics });
    else sendText(res, 200, 'image/png', renderStatusPng(view));
    return;
  }
  const personContentMatch = /^\/v1\/people\/([^/]+)\/content$/.exec(pathname);
  if (personContentMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!await requireAdmin(req, res, url)) return;
    const personId = decodeURIComponent(personContentMatch[1]);
    await getPersonIdentityIds(personId);
    if (req.method === 'DELETE') {
      await updatePersonal(personId, null);
      sendJson(res, 200, { configured: false });
      return;
    }
    const payload = await readRequestJson(req, 4 * 1024 * 1024 + 1024);
    const sentence = normalizeSentence(payload.sentence);
    const old = (await loadPersonalStore()).people?.[personId];
    const gifBase64 = payload.gifBase64 || old?.gifBase64;
    const prepared = prepareContent({ sentence, gifBase64 });
    const entry = { sentence, gifBase64, updatedAt: new Date().toISOString() };
    await updatePersonal(personId, entry);
    preparedPersonal.set(personId, { updatedAt: entry.updatedAt, content: prepared });
    sendJson(res, 200, { configured: true, sentence, updatedAt: entry.updatedAt, animation: true });
    return;
  }
  const sourceMatch = /^\/v1\/people\/([^/]+)\/sources\/([a-z][a-z0-9_-]{0,47})$/.exec(pathname);
  if (sourceMatch && req.method === 'PUT') {
    if (!await requireAdmin(req, res, url)) return;
    const personId = decodeURIComponent(sourceMatch[1]);
    const sourceId = sourceMatch[2];
    await getPersonIdentityIds(personId);
    if (sourceId === 'remotelab') throw Object.assign(new Error('remotelab is a reserved source'), { status: 400 });
    const payload = await readRequestJson(req);
    const result = await updateSignalStore((store) => replaceSource(store, personId, sourceId, payload));
    sendJson(res, 200, { changed: result.changed, reason: result.reason });
    return;
  }
  if (pathname === '/v1/enrollments' && req.method === 'POST') {
    if (!await requireAdmin(req, res, url)) return;
    const payload = await readRequestJson(req);
    const personId = trimString(payload.personId);
    await getPersonIdentityIds(personId);
    const token = newToken('rld_enroll');
    const createdAt = Date.now();
    const expiresAt = createdAt + enrollmentTtlMs;
    await updateState((state) => {
      state.enrollments = state.enrollments.filter((item) => !item.usedAt && item.expiresAt > createdAt);
      state.enrollments.push({ tokenHash: tokenHash(token), personId, createdAt, expiresAt, usedAt: null });
    });
    const origin = requestOrigin(req);
    const enrollmentUrl = `${origin}/v1/enroll/${encodeURIComponent(token)}`;
    const command = `curl -fsSL '${origin}/install.sh' | sh -s -- '${enrollmentUrl}'`;
    sendJson(res, 201, { enrollmentUrl, expiresAt: new Date(expiresAt).toISOString(), command });
    return;
  }
  const enrollmentMatch = /^\/v1\/enroll\/([^/]+)$/.exec(pathname);
  if (enrollmentMatch && req.method === 'POST') {
    const payload = await readRequestJson(req);
    const providedHash = tokenHash(decodeURIComponent(enrollmentMatch[1]));
    const now = Date.now();
    const result = await updateState((state) => {
      const enrollment = state.enrollments.find((item) => secureEqual(item.tokenHash, providedHash));
      if (!enrollment || enrollment.usedAt || enrollment.expiresAt <= now) return null;
      enrollment.usedAt = now;
      const deviceToken = newToken('rld_device');
      const device = {
        id: `display-${randomBytes(8).toString('hex')}`,
        tokenHash: tokenHash(deviceToken),
        personId: enrollment.personId,
        name: trimString(payload.name).slice(0, 100) || 'RemoteLab Display',
        hostname: trimString(payload.hostname).slice(0, 120),
        platform: trimString(payload.platform).slice(0, 80),
        createdAt: new Date(now).toISOString(),
        lastSeenAt: '',
        revokedAt: '',
      };
      state.devices.push(device);
      return { device, deviceToken };
    });
    if (!result) {
      sendJson(res, 410, { error: 'Enrollment link expired or already used' });
      return;
    }
    sendJson(res, 201, {
      deviceId: result.device.id,
      deviceToken: result.deviceToken,
      serverBaseUrl: requestOrigin(req),
      frameUrl: `${requestOrigin(req)}/v1/devices/${result.device.id}/frame.png`,
      heartbeatUrl: `${requestOrigin(req)}/v1/devices/${result.device.id}/heartbeat`,
      rotation: 180,
      pollSeconds: 8,
    });
    return;
  }
  if (pathname === '/v1/devices' && req.method === 'GET') {
    if (!await requireAdmin(req, res, url)) return;
    const personId = trimString(url.searchParams.get('personId'));
    await getPersonIdentityIds(personId);
    const state = await loadState();
    sendJson(res, 200, {
      devices: state.devices
        .filter((device) => device.personId === personId && !device.revokedAt)
        .map(({ tokenHash: _tokenHash, ...device }) => device),
    });
    return;
  }
  const adminDeviceMatch = /^\/v1\/devices\/(display-[a-f0-9]{16})$/.exec(pathname);
  if (adminDeviceMatch && req.method === 'DELETE') {
    if (!await requireAdmin(req, res, url)) return;
    const personId = trimString(url.searchParams.get('personId'));
    const revoked = await updateState((state) => {
      const device = state.devices.find((item) => item.id === adminDeviceMatch[1] && item.personId === personId);
      if (!device || device.revokedAt) return false;
      device.revokedAt = new Date().toISOString();
      return true;
    });
    if (!revoked) sendJson(res, 404, { error: 'Display not found' });
    else sendJson(res, 200, { ok: true });
    return;
  }
  if (adminDeviceMatch && req.method === 'PATCH') {
    if (!await requireAdmin(req, res, url)) return;
    const payload = await readRequestJson(req);
    const personId = trimString(payload.personId);
    await getPersonIdentityIds(personId);
    const claimed = await updateState((state) => {
      const device = state.devices.find((item) => item.id === adminDeviceMatch[1] && !item.personId && !item.revokedAt);
      if (!device) return false;
      device.personId = personId;
      return true;
    });
    if (!claimed) sendJson(res, 404, { error: 'Unowned display not found' });
    else sendJson(res, 200, { ok: true });
    return;
  }
  const deviceMatch = /^\/v1\/devices\/(display-[a-f0-9]{16})\/(frame\.png|heartbeat)$/.exec(pathname);
  if (deviceMatch) {
    const device = await authenticateDevice(req, deviceMatch[1]);
    if (!device) {
      sendJson(res, 401, { error: 'Device authentication failed' });
      return;
    }
    if (deviceMatch[2] === 'heartbeat' && req.method === 'POST') {
      const now = new Date().toISOString();
      await updateState((state) => {
        const current = state.devices.find((item) => item.id === device.id);
        if (current) current.lastSeenAt = now;
      });
      sendJson(res, 200, { ok: true, lastSeenAt: now });
      return;
    }
    if (deviceMatch[2] === 'frame.png' && req.method === 'GET') {
      if (!device.personId) {
        sendJson(res, 409, { error: 'Display ownership is not configured' });
        return;
      }
      const { png, snapshot, pollSeconds } = await renderFrame(device.personId);
      const now = new Date().toISOString();
      if (Date.now() - Date.parse(device.lastSeenAt || '') > 10_000 || !device.lastSeenAt) {
        await updateState((state) => {
          const current = state.devices.find((item) => item.id === device.id);
          if (current) current.lastSeenAt = now;
        });
      }
      sendText(res, 200, 'image/png', png, {
        'X-RemoteLab-Display-Observed-At': snapshot.observedAt,
        'X-RemoteLab-Display-Running': String(snapshot.running ?? ''),
        'X-RemoteLab-Display-Pending-Review': String(snapshot.pendingReview ?? ''),
        'X-RemoteLab-Display-Poll-Seconds': String(pollSeconds || 8),
      });
      return;
    }
  }
  sendJson(res, 404, { error: 'Not found' });
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('[display]', error);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || 'Internal error' });
    else res.destroy();
  });
});

server.listen(listenPort, bindHost, async () => {
  await ensureAdminToken();
  console.log(JSON.stringify({
    event: 'display_server_ready',
    listen: `http://${bindHost}:${listenPort}`,
  }));
});
