#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'remotelab-source-delivery-http-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab');
const bin = join(home, '.local/bin');
await mkdir(config, { recursive: true });
await mkdir(bin, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({ token: 'a'.repeat(64) }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify({ fixture: { expiry: Date.now() + 3600000, role: 'owner' } }));
await writeFile(join(config, 'tools.json'), JSON.stringify([{ id: 'fake-codex', name: 'Fixture Codex',
  command: 'fake-codex', runtimeFamily: 'codex-json', models: [{ id: 'fake-model', label: 'Fixture' }] }]));
await writeFile(join(bin, 'fake-codex'), `#!/usr/bin/env node
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture reply for delivery'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`);
await chmod(join(bin, 'fake-codex'), 0o755);
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
let logs = '';
const server = spawn(process.execPath, ['chat-server.mjs'], { cwd: repo,
  env: { ...process.env, HOME: home, CHAT_PORT: String(port), SECURE_COOKIES: '0',
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH || ''}` },
  stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', data => { logs += data; });
server.stderr.on('data', data => { logs += data; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timeout: ${label}\n${logs.slice(-3000)}`);
}
async function request(method, path, body) {
  const multipart = body instanceof FormData;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Cookie: 'session_token=fixture', ...(!multipart && body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}
try {
  await waitFor(async () => {
    try { return (await request('GET', '/api/auth/me')).status === 200; } catch { return false; }
  }, 'server startup');
  for (const encoding of ['json', 'multipart']) {
    const created = await request('POST', '/api/sessions', { folder: home, tool: 'fake-codex', name: `Fixture ${encoding}` });
    assert.equal(created.status, 201);
    const sessionId = created.body.session.id;
    const requestId = `fixture-${encoding}`;
    const sourceDelivery = { connector: 'feishu', sourceRouteId: 'fixture-bot-2', target: {
      chatId: `fixture-chat-${encoding}`, messageId: `fixture-message-${encoding}`, chatType: 'group', replyInThread: true,
    } };
    const payload = { requestId, text: 'Return the fixture reply.', tool: 'fake-codex', model: 'fake-model', sourceDelivery };
    let body = payload;
    if (encoding === 'multipart') {
      body = new FormData();
      for (const [key, value] of Object.entries(payload)) body.set(key, typeof value === 'object' ? JSON.stringify(value) : value);
      body.append('attachments', new Blob(['fixture input attachment'], { type: 'text/plain' }), 'fixture.txt');
    }
    const submitted = await request('POST', `/api/sessions/${sessionId}/messages`, body);
    assert.equal(submitted.status, 202);
    const key = createHash('sha256').update(JSON.stringify([sessionId, requestId])).digest('hex').slice(0, 24);
    const record = JSON.parse(await readFile(join(config, 'requests/active', `${key}.json`), 'utf8'));
    assert.deepEqual(record.options.sourceDelivery, sourceDelivery, `${encoding} admission must preserve the explicit delivery route`);
    const delivery = await waitFor(async () => {
      const result = await request('GET', '/api/source-deliveries?connector=feishu&sourceRouteId=fixture-bot-2');
      assert.equal(result.status, 200);
      return result.body.deliveries.find(item => item.runId === submitted.body.run.id && item.text?.includes('fixture reply for delivery'));
    }, `${encoding} generated reply in outbox`);
    assert.equal(delivery.sourceRouteId, 'fixture-bot-2');
    assert.deepEqual(delivery.target, sourceDelivery.target);
    assert.equal(delivery.state, 'pending');
    if (encoding === 'json') {
      const repeated = await request('POST', `/api/sessions/${sessionId}/messages`, payload);
      assert.equal(repeated.status, 200);
      assert.equal(repeated.body.duplicate, true);
      assert.equal(repeated.body.run.id, submitted.body.run.id);
    }
  }
  console.log('PASS: JSON and multipart HTTP admission preserve sourceDelivery through generated reply/outbox; no external sender invoked');
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await waitFor(() => server.exitCode !== null || server.signalCode !== null, 'server shutdown');
  }
  await rm(home, { recursive: true, force: true });
}
