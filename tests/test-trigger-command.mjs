import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

const tempRoot = mkdtempSync(join(tmpdir(), 'remotelab-trigger-command-'));
const homeDir = join(tempRoot, 'home');
mkdirSync(join(homeDir, '.config', 'remotelab'), { recursive: true });
writeFileSync(join(homeDir, '.config', 'remotelab', 'auth.json'), `${JSON.stringify({ token: 'owner-token' })}\n`, 'utf8');
process.env.HOME = homeDir;
process.env.REMOTELAB_SESSION_ID = 'sess-current';

const requests = [];
let triggerCounter = 0;
const sockets = new Set();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' && url.searchParams.get('token') === 'owner-token') {
    res.writeHead(302, {
      'Set-Cookie': 'remotelab_session=owner; Path=/',
      Location: '/app',
    });
    res.end();
    return;
  }

  const cookie = req.headers.cookie || '';
  if (!cookie.includes('remotelab_session=owner')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  const parsedBody = body ? JSON.parse(body) : null;
  requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body: parsedBody });

  if (req.method === 'POST' && url.pathname === '/api/triggers') {
    triggerCounter += 1;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      trigger: {
        id: `trg_${String(triggerCounter).padStart(24, '0')}`,
        status: 'pending',
        sessionId: parsedBody.sessionId,
        scheduledAt: parsedBody.scheduledAt,
        text: parsedBody.text,
        title: parsedBody.title || '',
      },
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/triggers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      triggers: [{
        id: 'trg_000000000000000000000001',
        status: 'pending',
        sessionId: url.searchParams.get('sessionId') || 'sess-other',
        scheduledAt: '2026-03-20T00:00:00.000Z',
        text: 'hello',
        title: 'sample',
      }],
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/triggers/trg_000000000000000000000001') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      trigger: {
        id: 'trg_000000000000000000000001',
        status: 'pending',
        sessionId: 'sess-current',
        scheduledAt: '2026-03-20T00:00:00.000Z',
        text: 'hello',
        title: 'sample',
      },
    }));
    return;
  }

  if (req.method === 'PATCH' && url.pathname === '/api/triggers/trg_000000000000000000000001') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      trigger: {
        id: 'trg_000000000000000000000001',
        status: 'cancelled',
        sessionId: 'sess-current',
        scheduledAt: '2026-03-20T00:00:00.000Z',
        text: 'hello',
      },
    }));
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/triggers/trg_000000000000000000000001') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      trigger: {
        id: 'trg_000000000000000000000001',
        status: 'cancelled',
        sessionId: 'sess-current',
        scheduledAt: '2026-03-20T00:00:00.000Z',
        text: 'hello',
      },
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

const { runTriggerCommand } = await import('../lib/trigger-command.mjs');

async function runCli(args) {
  let stdout = '';
  const code = await runTriggerCommand(args, {
    stdout: {
      write(chunk) {
        stdout += String(chunk);
      },
    },
  });
  return { code, stdout };
}

const created = JSON.parse((await runCli([
  'create',
  '--in', '10m',
  '--text', 'remind me later',
  '--title', 'Later',
  '--base-url', baseUrl,
  '--json',
])).stdout);
assert.equal(created.trigger.sessionId, 'sess-current');
assert.equal(created.trigger.title, 'Later');
assert.equal(requests.at(-1)?.body?.sessionId, 'sess-current');
assert.equal(requests.at(-1)?.body?.text, 'remind me later');
assert.equal(requests.at(-1)?.body?.deliverTo, 'session_source');
assert.ok(typeof requests.at(-1)?.body?.scheduledAt === 'string' && requests.at(-1).body.scheduledAt.includes('T'));

const listed = JSON.parse((await runCli(['list', '--session', 'sess-current', '--base-url', baseUrl, '--json'])).stdout);
assert.equal(listed.triggers.length, 1);
assert.equal(requests.at(-1)?.query?.get('sessionId'), 'sess-current');

const loaded = JSON.parse((await runCli(['get', 'trg_000000000000000000000001', '--base-url', baseUrl, '--json'])).stdout);
assert.equal(loaded.trigger.id, 'trg_000000000000000000000001');

const cancelled = JSON.parse((await runCli(['cancel', 'trg_000000000000000000000001', '--base-url', baseUrl, '--json'])).stdout);
assert.equal(cancelled.trigger.status, 'cancelled');
assert.equal(requests.at(-1)?.body?.enabled, false);

const deleted = JSON.parse((await runCli(['delete', 'trg_000000000000000000000001', '--base-url', baseUrl, '--json'])).stdout);
assert.equal(deleted.trigger.id, 'trg_000000000000000000000001');

for (const socket of sockets) {
  socket.destroy();
}
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));

console.log('test-trigger-command: ok');
