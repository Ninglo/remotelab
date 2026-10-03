import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const root = await mkdtemp(join(tmpdir(), 'workboard-worker-'));
let available = false;
const server = createServer((req, res) => {
  if (req.url.startsWith('/?token=')) { res.writeHead(302, { 'set-cookie': 'session_token=fixture' }); res.end(); return; }
  res.writeHead(available ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify(available ? { sessions: [] } : { error: 'controller starting' }));
});
const sockets = new WebSocketServer({ server });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await writeFile(join(root, 'auth.json'), JSON.stringify({ version: 2, serviceToken: 'fixture-token', people: [{ id: 'person_default', name: 'Fixture' }] }));
await writeFile(join(root, 'bot.json'), JSON.stringify({ appId: 'fixture-app', appSecret: 'fixture-secret', chatBaseUrl: `http://127.0.0.1:${server.address().port}` }));
const statePath = join(root, 'state.json');
await writeFile(statePath, JSON.stringify({ scope: 'instance', sourceRouteId: 'default', botConfigPath: join(root, 'bot.json'), sessions: {}, protocolVersion: 2 }));
const child = spawn(process.execPath, ['scripts/feishu-workboard-pilot.mjs', statePath], {
  env: { ...process.env, REMOTELAB_CONFIG_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
const listeners = new Set();
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
  output += data;
  for (const listener of listeners) listener();
});
function awaitOutput(pattern, after = 0) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Missing ${pattern}: ${output}`)); }, 10000);
    const check = () => { if (pattern.test(output.slice(after))) { clearTimeout(timer); listeners.delete(check); resolve(); } };
    listeners.add(check); check();
  });
}
try {
  const firstConnection = once(sockets, 'connection');
  await awaitOutput(/startup: controller starting/);
  assert.equal(child.exitCode, null, 'cold startup keeps the worker alive');
  available = true;
  await awaitOutput(/ready route=default scope=instance/);
  const [firstSocket] = await firstConnection;
  const before = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(before.runtime.pid, child.pid);
  const secondConnection = once(sockets, 'connection');
  const offset = output.length;
  available = false;
  firstSocket.terminate();
  await awaitOutput(/reconnect: controller starting/, offset);
  available = true;
  await awaitOutput(/ready route=default scope=instance/, offset);
  await secondConnection;
  const after = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(after.runtime.pid, before.runtime.pid, 'controller restart does not restart the worker or lose receipts');
  assert.equal(child.exitCode, null);
  console.log('PASS: route worker survives delayed controller startup and reconnects in the same process, without any Feishu provider call.');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped;
  }
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
