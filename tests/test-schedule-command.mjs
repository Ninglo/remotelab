#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

const tempRoot = mkdtempSync(join(tmpdir(), 'remotelab-schedule-command-'));
const homeDir = join(tempRoot, 'home');
mkdirSync(join(homeDir, '.config', 'remotelab'), { recursive: true });
writeFileSync(join(homeDir, '.config', 'remotelab', 'auth.json'), `${JSON.stringify({ token: 'owner-token' })}\n`);
process.env.HOME = homeDir;
process.env.REMOTELAB_SESSION_ID = 'sess-current';
process.env.REMOTELAB_REQUEST_ID = 'feishu:om_current';

const requests = [];
const schedule = {
  id: 'sch_000000000000000000000001',
  status: 'active',
  sessionId: 'sess-current',
  cron: '0 9 * * 1-5',
  timezone: 'Asia/Shanghai',
  nextRunAt: '2026-07-28T01:00:00.000Z',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' && url.searchParams.get('token') === 'owner-token') {
    res.writeHead(302, { 'Set-Cookie': 'remotelab_session=owner; Path=/', Location: '/app' });
    res.end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  requests.push({ method: req.method, path: url.pathname, body, query: url.searchParams });
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && url.pathname === '/api/schedules') {
    res.writeHead(201);
    res.end(JSON.stringify({ schedule: { ...schedule, ...body } }));
  } else if (req.method === 'GET' && url.pathname === '/api/schedules') {
    res.end(JSON.stringify({ schedules: [schedule] }));
  } else if (req.method === 'PATCH' && url.pathname === `/api/schedules/${schedule.id}`) {
    res.end(JSON.stringify({ schedule: { ...schedule, status: 'cancelled', enabled: false } }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const { runScheduleCommand } = await import('../lib/schedule-command.mjs');

async function run(args) {
  let stdout = '';
  await runScheduleCommand([...args, '--base-url', baseUrl, '--json'], {
    stdout: { write: (chunk) => { stdout += String(chunk); } },
  });
  return JSON.parse(stdout);
}

const created = await run(['create', '--cron', '0 9 * * 1-5', '--text', 'Send date']);
assert.equal(created.schedule.id, schedule.id);
assert.equal(requests.at(-1).body.deliverTo, undefined, 'ordinary Session is the default');
assert.equal(requests.at(-1).body.sourceRequestId, undefined);
assert.equal(requests.at(-1).body.timezone, 'Asia/Shanghai');


const base = ['create', '--cron', '0 9 * * *', '--text', 'hello'];
const createWith = async (...args) => { await run([...base, ...args]); return requests.at(-1).body; };
assert.equal((await createWith('--conversation', 'source')).deliverTo, 'session_source');
const binding = { connector: 'feishu', sourceRouteId: 'bot-2', target: { chatId: 'recordings' } };
assert.deepEqual((await createWith('--conversation', JSON.stringify(binding))).conversation, binding);
const bindingPath = join(tempRoot, 'conversation.json');
writeFileSync(bindingPath, JSON.stringify(binding));
assert.deepEqual((await createWith('--conversation-file', bindingPath)).conversation, binding);
assert.equal((await createWith('--source-request', 'feishu:explicit')).deliverTo, 'session_source');
assert.equal((await createWith('--source-request', 'feishu:explicit')).sourceRequestId, 'feishu:explicit');
assert.equal((await createWith('--no-source-delivery')).deliverTo, undefined);
const beforeInvalid = requests.length;
await assert.rejects(createWith('--conversation', '{}'), /Invalid conversation/);
await assert.rejects(createWith('--conversation', 'source', '--conversation-file', bindingPath), /Choose one/);
assert.equal(requests.length, beforeInvalid, 'invalid binding must fail before admission');

const listed = await run(['list']);
assert.equal(listed.schedules.length, 1);
assert.equal(requests.at(-1).query.get('sessionId'), 'sess-current');

const cancelled = await run(['cancel', schedule.id, '--include-active']);
assert.equal(cancelled.schedule.status, 'cancelled');
assert.equal(requests.at(-1).body.includeActive, true);

await new Promise((resolve) => server.close(resolve));
console.log('test-schedule-command: ok');
