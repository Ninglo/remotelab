import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { authenticateBearerToken, getAuthSession } from '../lib/auth.mjs';

const PREFIX = '/browser';
const SOCKET_PATH = `${PREFIX}/websockify`;
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
};

export function isBrowserDesktopPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

async function ownerStatus(req) {
  await authenticateBearerToken(req);
  const session = getAuthSession(req);
  return !session ? 401 : session.role === 'owner' ? 200 : 403;
}

async function loadDesktop() {
  let config;
  try {
    config = JSON.parse(await readFile(join(CONFIG_DIR, 'browser-desktop.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (config.enabled === false) return null;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535
    || typeof config.authFile !== 'string' || !isAbsolute(config.authFile)) {
    throw new Error('Invalid browser desktop configuration');
  }
  const credentials = JSON.parse(await readFile(config.authFile, 'utf8'));
  if (typeof credentials.username !== 'string' || !credentials.username
    || credentials.username.includes(':') || typeof credentials.password !== 'string' || !credentials.password) {
    throw new Error('Invalid browser desktop credentials');
  }
  return {
    port: config.port,
    authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
  };
}

function upstreamOptions(req, url, desktop, upgrade = false) {
  // Never pass the owner's cookies/token or caller-selected destinations upstream.
  const headers = {
    host: `127.0.0.1:${desktop.port}`,
    authorization: desktop.authorization,
  };
  const allowed = upgrade
    ? ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']
    : ['accept', 'accept-language'];
  for (const name of allowed) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  if (upgrade) {
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    headers.origin = `http://127.0.0.1:${desktop.port}`;
  }
  return {
    hostname: '127.0.0.1', port: desktop.port, method: req.method,
    path: `${url.pathname.slice(PREFIX.length)}${url.search}`, headers,
  };
}

function respond(res, status, message, extra = {}) {
  res.writeHead(status, { ...PRIVATE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra });
  res.end(message);
}

export async function handleBrowserDesktopRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!isBrowserDesktopPath(url.pathname)) return false;
  const status = await ownerStatus(req);
  if (status !== 200) {
    if (status === 401) respond(res, 302, '', { Location: `/login?next=${encodeURIComponent(req.url)}` });
    else respond(res, 403, 'Owner access required');
    return true;
  }
  let desktop;
  try { desktop = await loadDesktop(); } catch {
    respond(res, 503, 'Browser desktop is unavailable');
    return true;
  }
  if (!desktop) { respond(res, 404, 'Browser desktop is not configured'); return true; }
  if (!['GET', 'HEAD'].includes(req.method)) {
    respond(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return true;
  }
  if (url.pathname === PREFIX || url.pathname === `${PREFIX}/`) {
    respond(res, 302, '', { Location: `${PREFIX}/vnc.html?autoconnect=1&resize=scale&path=browser%2Fwebsockify` });
    return true;
  }
  if (url.pathname === SOCKET_PATH) { respond(res, 426, 'WebSocket upgrade required'); return true; }
  const upstream = http.request(upstreamOptions(req, url, desktop), (response) => {
    // Do not expose upstream credentials, cookies, redirects or cache policies.
    if (![200, 404].includes(response.statusCode)) {
      response.resume();
      respond(res, 502, 'Browser desktop is unavailable');
      return;
    }
    res.writeHead(response.statusCode, {
      ...PRIVATE_HEADERS,
      'Content-Type': response.headers['content-type'] || 'application/octet-stream',
    });
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.setTimeout(15000, () => upstream.destroy(new Error('Desktop HTTP connection stalled')));
  upstream.on('error', () => {
    if (!res.headersSent) respond(res, 502, 'Browser desktop is unavailable');
    else res.destroy();
  });
  res.on('close', () => upstream.destroy());
  upstream.end();
  return true;
}

function rejectUpgrade(socket, status) {
  const message = http.STATUS_CODES[status];
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function sameOrigin(req) {
  try {
    const protocol = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    return ['http', 'https'].includes(protocol)
      && new URL(req.headers.origin).origin === `${protocol}://${req.headers.host}`;
  } catch { return false; }
}

export async function handleBrowserDesktopUpgrade(req, socket, head) {
  socket.on('error', () => socket.destroy());
  const url = new URL(req.url, 'http://localhost');
  const status = await ownerStatus(req);
  if (status !== 200) { rejectUpgrade(socket, status); return; }
  if (!sameOrigin(req)) { rejectUpgrade(socket, 403); return; }
  if (url.pathname !== SOCKET_PATH || req.method !== 'GET'
    || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    rejectUpgrade(socket, 404); return;
  }
  let desktop;
  try { desktop = await loadDesktop(); } catch { rejectUpgrade(socket, 503); return; }
  if (!desktop) { rejectUpgrade(socket, 404); return; }
  const upstream = http.request(upstreamOptions(req, url, desktop, true));
  const handshakeTimer = setTimeout(() => upstream.destroy(new Error('Desktop upgrade stalled')), 15000);
  let connected = false;
  let peer;
  socket.on('close', () => { clearTimeout(handshakeTimer); upstream.destroy(); peer?.destroy(); });
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    clearTimeout(handshakeTimer);
    peer = upstreamSocket;
    if (socket.destroyed) { peer.destroy(); return; }
    connected = true;
    const headers = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket'];
    for (const name of ['sec-websocket-accept', 'sec-websocket-protocol']) {
      if (response.headers[name]) headers.push(`${name}: ${response.headers[name]}`);
    }
    socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) peer.write(head);
    peer.on('error', () => socket.destroy());
    peer.on('close', () => socket.destroy());
    // Only the handshake is bounded; an active desktop has no application deadline.
    peer.pipe(socket).pipe(peer);
  });
  upstream.on('response', (response) => {
    clearTimeout(handshakeTimer);
    response.resume();
    rejectUpgrade(socket, 502);
  });
  upstream.on('error', () => {
    clearTimeout(handshakeTimer);
    if (!connected && !socket.destroyed) rejectUpgrade(socket, 502);
    else socket.destroy();
  });
  upstream.end();
}
