#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

import { createRemoteLabHttpClient } from '../lib/remotelab-http-client.mjs';
import { createSerialTaskQueue, readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';

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
const enrollmentTtlMs = 10 * 60 * 1000;
const saveState = createSerialTaskQueue();
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

function requestOrigin(req) {
  if (publicBaseUrl) return publicBaseUrl;
  const forwardedProto = trimString(req.headers['x-forwarded-proto']).split(',')[0] || 'http';
  const forwardedHost = trimString(req.headers['x-forwarded-host']).split(',')[0];
  const host = forwardedHost || trimString(req.headers.host);
  return host ? `${forwardedProto}://${host}` : `http://${bindHost}:${listenPort}`;
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

async function collectSnapshot() {
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

async function renderFrame() {
  const snapshot = await collectSnapshot();
  const renderer = new Resvg(snapshotSvg(snapshot), {
    background: '#0b0f13',
    font: { loadSystemFonts: true, defaultFontFamily: 'sans-serif' },
  });
  return { png: Buffer.from(renderer.render().asPng()), snapshot };
}

function settingsHtml(adminToken) {
  const safeToken = JSON.stringify(adminToken).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>RemoteLab 副屏</title><style>
  :root{color-scheme:dark}body{margin:0;background:#0b0f13;color:#edf2f5;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:820px;margin:56px auto;padding:0 24px}h1{font-size:30px;margin:0 0 8px}p{color:#91a0aa;line-height:1.6}.panel{margin-top:28px;padding:24px;border:1px solid #26323a;border-radius:18px;background:#111820}button{border:0;border-radius:10px;padding:11px 16px;background:#56e0b4;color:#07110e;font-weight:700;cursor:pointer}pre{white-space:pre-wrap;word-break:break-all;padding:16px;border-radius:12px;background:#080b0e;color:#cbd5db;min-height:44px}.device{padding:12px 0;border-top:1px solid #26323a}.ok{color:#56e0b4}.muted{color:#71818b}</style></head>
  <body><main class="wrap"><h1>副屏设备</h1><p>此页面和安装脚本均由当前 RemoteLab Server 提供。生成的命令只会把副屏连接到本实例。</p>
  <section class="panel"><button id="create">生成一次性安装命令</button><pre id="command">点击上方按钮生成。命令有效期 10 分钟，只能使用一次。</pre><button id="copy" hidden>复制命令</button></section>
  <section class="panel"><h2>已连接设备</h2><div id="devices" class="muted">正在读取…</div></section></main>
  <script>const admin=${safeToken};const command=document.getElementById('command');const copy=document.getElementById('copy');
  async function api(path,options={}){const joiner=path.includes('?')?'&':'?';const response=await fetch(path+joiner+'admin='+encodeURIComponent(admin),options);if(!response.ok)throw new Error((await response.json()).error||'请求失败');return response.json()}
  function deviceRow(device){const row=document.createElement('div');row.className='device';const name=document.createElement('strong');name.textContent=device.name;const meta=document.createElement('div');meta.className='muted';meta.textContent=device.id+' · '+(device.lastSeenAt?'最近在线 '+device.lastSeenAt:'尚未连接');row.append(name,meta);return row}
  async function load(){const data=await api('/v1/devices');const root=document.getElementById('devices');root.replaceChildren();if(!data.devices.length){root.textContent='还没有副屏设备。';return}for(const device of data.devices)root.append(deviceRow(device))}
  document.getElementById('create').onclick=async()=>{try{const data=await api('/v1/enrollments',{method:'POST'});command.textContent=data.command;copy.hidden=false}catch(error){command.textContent=error.message}};
  copy.onclick=async()=>{await navigator.clipboard.writeText(command.textContent);copy.textContent='已复制'};load().catch(e=>document.getElementById('devices').textContent=e.message);</script></body></html>`;
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
  if ((pathname === '/' || pathname === '/settings') && req.method === 'GET') {
    if (!await requireAdmin(req, res, url)) return;
    sendText(res, 200, 'text/html; charset=utf-8', settingsHtml(adminCredential(req, url)), {
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    });
    return;
  }
  if (pathname === '/v1/enrollments' && req.method === 'POST') {
    if (!await requireAdmin(req, res, url)) return;
    const token = newToken('rld_enroll');
    const createdAt = Date.now();
    const expiresAt = createdAt + enrollmentTtlMs;
    await updateState((state) => {
      state.enrollments = state.enrollments.filter((item) => !item.usedAt && item.expiresAt > createdAt);
      state.enrollments.push({ tokenHash: tokenHash(token), createdAt, expiresAt, usedAt: null });
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
    const state = await loadState();
    sendJson(res, 200, {
      devices: state.devices.filter((device) => !device.revokedAt).map(({ tokenHash: _tokenHash, ...device }) => device),
    });
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
      const { png, snapshot } = await renderFrame();
      const now = new Date().toISOString();
      await updateState((state) => {
        const current = state.devices.find((item) => item.id === device.id);
        if (current) current.lastSeenAt = now;
      });
      sendText(res, 200, 'image/png', png, {
        'X-RemoteLab-Display-Observed-At': snapshot.observedAt,
        'X-RemoteLab-Display-Running': String(snapshot.running),
        'X-RemoteLab-Display-Pending-Review': String(snapshot.pendingReview),
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
  const adminToken = await ensureAdminToken();
  console.log(JSON.stringify({
    event: 'display_server_ready',
    listen: `http://${bindHost}:${listenPort}`,
    settingsUrl: `${publicBaseUrl || `http://${bindHost}:${listenPort}`}/settings?admin=${adminToken}`,
  }));
});
