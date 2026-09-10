import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const testHome = await mkdtemp(join(tmpdir(), 'remotelab-desktop-test-'));
setIsolatedTestHome(testHome);
const configDir = join(testHome, '.config/remotelab');
await mkdir(configDir, { recursive: true });
const token = 'a'.repeat(64);
await writeFile(join(configDir, 'auth.json'), JSON.stringify({ token }));
await writeFile(join(configDir, 'auth-sessions.json'), JSON.stringify({
  owner: { role: 'owner', expiry: Date.now() + 60000 },
  visitor: { role: 'visitor', visitorId: 'v', agentId: 'a', expiry: Date.now() + 60000 },
  expired: { role: 'owner', expiry: Date.now() - 1 },
}));
const { handleBrowserDesktopRequest, handleBrowserDesktopUpgrade } =
  await import('../chat/browser-desktop-proxy.mjs');
const received = [];
const upstream = http.createServer((req, res) => {
  received.push({ path: req.url, headers: req.headers });
  res.writeHead(200, {
    'Content-Type': req.url.endsWith('.js') ? 'text/javascript' : 'text/html',
    'Set-Cookie': 'upstream-secret=must-not-escape',
    'Cache-Control': 'public, max-age=3600',
  });
  res.end('<html>desktop</html>');
});
const upstreamWs = new WebSocketServer({ noServer: true });
upstream.on('upgrade', (req, socket, head) => {
  received.push({ path: req.url, headers: req.headers });
  upstreamWs.handleUpgrade(req, socket, head, (ws) => {
    ws.send(Buffer.from('RFB 003.008\n'));
    ws.on('message', (data, binary) => ws.send(data, { binary }));
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const port = upstream.address().port;
const authFile = join(testHome, 'desktop-auth.json');
await writeFile(authFile, JSON.stringify({ username: 'desktop', password: 'private-upstream-password' }));
const configFile = join(configDir, 'browser-desktop.json');
await writeFile(configFile, JSON.stringify({ port, authFile }));
const server = http.createServer((req, res) => {
  handleBrowserDesktopRequest(req, res).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }).catch(error => { res.writeHead(500); res.end(error.message); });
});
server.on('upgrade', (req, socket, head) => {
  handleBrowserDesktopUpgrade(req, socket, head).catch(() => socket.destroy());
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const owner = { Cookie: 'session_token=owner' };
const request = (path, headers = owner, method = 'GET') => fetch(`${base}${path}`, {
  headers, method, redirect: 'manual',
});
async function rejectedUpgrade(headers, expected, path = '/browser/websockify') {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}${path}`, { headers });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      try { assert.equal(res.statusCode, expected); resolve(); } catch (error) { reject(error); }
    });
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected upgrade')); });
    ws.on('error', reject);
  });
}
try {
  const anonymous = await request('/browser/', {});
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('location'), '/login?next=%2Fbrowser%2F');
  assert.equal((await request('/browser/app/ui.js', { Cookie: 'visitor_session_token=visitor' })).status, 403);
  assert.equal((await request('/browser/', { Cookie: 'session_token=expired' })).status, 302);
  assert.equal(received.length, 0, 'Rejected users must not reach upstream');
  const entry = await request('/browser/');
  assert.equal(entry.status, 302);
  assert.match(entry.headers.get('location'), /path=browser%2Fwebsockify/);
  const page = await request('/browser/vnc.html', { ...owner, Authorization: `Bearer ${token}` });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<html>desktop</html>');
  assert.equal(page.headers.get('set-cookie'), null);
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(received.at(-1).path, '/vnc.html');
  assert.equal(received.at(-1).headers.cookie, undefined);
  assert.equal(received.at(-1).headers.authorization, `Basic ${Buffer.from('desktop:private-upstream-password').toString('base64')}`);
  assert.equal((await request('/browser/app/ui.js')).headers.get('content-type'), 'text/javascript');
  assert.equal((await request('/browser/vnc.html', owner, 'POST')).status, 405);
  assert.equal((await request('/browser/websockify')).status, 426);
  await rejectedUpgrade({ Origin: base }, 401);
  await rejectedUpgrade({ Origin: base, Cookie: 'visitor_session_token=visitor' }, 403);
  await rejectedUpgrade(owner, 403);
  await rejectedUpgrade({ ...owner, Origin: 'https://attacker.invalid' }, 403);
  await rejectedUpgrade({ ...owner, Origin: base }, 404, '/browser/other-socket');
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/browser/websockify`, ['binary'], {
    headers: { ...owner, Origin: base },
  });
  const banner = await once(ws, 'message');
  assert.equal(banner[0].toString(), 'RFB 003.008\n');
  assert.equal(banner[1], true);
  const echoed = once(ws, 'message');
  ws.send(Buffer.from([0, 255, 1, 2]));
  assert.deepEqual((await echoed)[0], Buffer.from([0, 255, 1, 2]));
  const closed = once(ws, 'close');
  ws.close();
  await closed;
  assert.equal(received.at(-1).headers.origin, `http://127.0.0.1:${port}`);
  assert.equal(received.at(-1).headers.cookie, undefined);
  await writeFile(configFile, JSON.stringify({ port: 'invalid', authFile }));
  assert.equal((await request('/browser/vnc.html')).status, 503);
  await rm(configFile);
  assert.equal((await request('/browser/')).status, 404);
  await rejectedUpgrade({ ...owner, Origin: base }, 404);
  console.log('browser-desktop-proxy: HTTP owner/visitor/expiry, private headers, assets, binary WS, Origin, disabled/config validation passed');
} finally {
  for (const ws of upstreamWs.clients) ws.terminate();
  upstreamWs.close();
  server.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]);
  await rm(testHome, { recursive: true, force: true });
}
