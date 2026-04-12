#!/usr/bin/env node

import { readFile } from 'fs/promises';
import http from 'http';
import net from 'net';
import { homedir } from 'os';
import { join } from 'path';

const LISTEN_HOST = String(process.env.HK_HOST_ROUTER_LISTEN_HOST || '127.0.0.1').trim() || '127.0.0.1';
const LISTEN_PORT = Number.parseInt(process.env.HK_HOST_ROUTER_LISTEN_PORT, 10) || 7705;
const OWNER_LABEL = normalizeLabel(process.env.HK_HOST_ROUTER_OWNER_LABEL || 'owner');
const OWNER_PORT = Number.parseInt(process.env.HK_HOST_ROUTER_OWNER_PORT, 10) || 7690;
const HUB_LABEL = normalizeLabel(process.env.HK_HOST_ROUTER_HUB_LABEL || 'hub');
const HUB_PORT = Number.parseInt(process.env.HK_HOST_ROUTER_HUB_PORT, 10) || 7699;
const ADMIN_LABEL = normalizeLabel(process.env.HK_HOST_ROUTER_ADMIN_LABEL || 'admin');
const ADMIN_PORT = Number.parseInt(process.env.HK_HOST_ROUTER_ADMIN_PORT, 10) || 7689;
const GUEST_REGISTRY_FILE = join(homedir(), '.config', 'remotelab', 'guest-instances.json');

let registryCache = { loadedAt: 0, routes: new Map() };

function normalizeLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.+$/, '');
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function stripPort(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return '';
  if (normalized.startsWith('[')) {
    const closingIndex = normalized.indexOf(']');
    if (closingIndex >= 0) return normalized.slice(1, closingIndex);
  }
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon > 0 && normalized.indexOf(':') === lastColon) {
    return normalized.slice(0, lastColon);
  }
  return normalized;
}

function firstLabel(host) {
  const normalized = stripPort(host);
  return normalizeLabel(normalized.split('.').filter(Boolean)[0] || '');
}

function writePlain(res, statusCode, body) {
  const text = String(body || '');
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function loadGuestRoutes() {
  const now = Date.now();
  if (now - registryCache.loadedAt < 5000) return registryCache.routes;

  const routes = new Map();
  routes.set(OWNER_LABEL, OWNER_PORT);
  routes.set(HUB_LABEL, HUB_PORT);
  routes.set(ADMIN_LABEL, ADMIN_PORT);

  try {
    const parsed = JSON.parse(await readFile(GUEST_REGISTRY_FILE, 'utf8'));
    if (Array.isArray(parsed)) {
      for (const record of parsed) {
        const port = Number.parseInt(record?.port, 10);
        if (!isValidPort(port) || port === LISTEN_PORT) continue;

        const name = normalizeLabel(record?.name);
        const hostname = stripPort(record?.hostname);
        const hostLabel = firstLabel(hostname);

        if (name) routes.set(name, port);
        if (hostname) routes.set(hostname, port);
        if (hostLabel) routes.set(hostLabel, port);
      }
    }
  } catch {
    // Keep static routes only.
  }

  registryCache = { loadedAt: now, routes };
  return routes;
}

async function resolveUpstream(req) {
  const routes = await loadGuestRoutes();
  const hostHeader = stripPort(req.headers?.['x-forwarded-host'] || req.headers?.host || '');
  const label = firstLabel(hostHeader);

  if (hostHeader && routes.has(hostHeader)) {
    return { hostHeader, label, upstreamPort: routes.get(hostHeader) };
  }
  if (label && routes.has(label)) {
    return { hostHeader, label, upstreamPort: routes.get(label) };
  }
  return { hostHeader, label, upstreamPort: OWNER_PORT };
}

function buildUpstreamHeaders(req, hostHeader) {
  const headers = { ...req.headers };
  delete headers['content-length'];
  headers.host = hostHeader || req.headers.host || '';
  headers['x-forwarded-host'] = hostHeader || req.headers.host || '';
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  return headers;
}

function proxyHttp(req, res, upstreamPort, hostHeader) {
  const upstreamReq = http.request({
    host: LISTEN_HOST,
    port: upstreamPort,
    method: req.method,
    path: req.url || '/',
    headers: buildUpstreamHeaders(req, hostHeader),
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (error) => {
    writePlain(res, 502, `host router upstream error: ${error.message}\n`);
  });

  req.pipe(upstreamReq);
}

function proxyUpgrade(req, socket, head, upstreamPort, hostHeader) {
  const upstreamSocket = net.connect(upstreamPort, LISTEN_HOST, () => {
    const headers = buildUpstreamHeaders(req, hostHeader);
    const rawHeaders = [];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) rawHeaders.push(`${key}: ${item}`);
        continue;
      }
      if (value == null) continue;
      rawHeaders.push(`${key}: ${value}`);
    }
    upstreamSocket.write(`${req.method} ${req.url || '/'} HTTP/${req.httpVersion}\r\n${rawHeaders.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
  });

  upstreamSocket.on('error', () => socket.destroy());
  socket.on('error', () => upstreamSocket.destroy());
}

const server = http.createServer(async (req, res) => {
  const { hostHeader, label, upstreamPort } = await resolveUpstream(req);
  if (!isValidPort(upstreamPort) || upstreamPort === LISTEN_PORT) {
    writePlain(res, 502, `host router has no upstream for host=${hostHeader || '-'} label=${label || '-'}\n`);
    return;
  }
  proxyHttp(req, res, upstreamPort, hostHeader);
});

server.on('upgrade', async (req, socket, head) => {
  const { hostHeader, upstreamPort } = await resolveUpstream(req);
  if (!isValidPort(upstreamPort) || upstreamPort === LISTEN_PORT) {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
    return;
  }
  proxyUpgrade(req, socket, head, upstreamPort, hostHeader);
});

server.listen(LISTEN_PORT, LISTEN_HOST, async () => {
  const routes = await loadGuestRoutes();
  const keys = [...routes.keys()].slice(0, 12).join(', ');
  console.log(`hk host router listening on http://${LISTEN_HOST}:${LISTEN_PORT} with ${routes.size} routes (${keys}${routes.size > 12 ? ', ...' : ''})`);
});
