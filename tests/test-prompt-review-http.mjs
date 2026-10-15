import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'prompt-review-http-'));
setIsolatedTestHome(home);
const dir = join(home, '.config/remotelab'); await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'auth.json'), JSON.stringify({ token: 'a'.repeat(64) }));
await writeFile(join(dir, 'auth-sessions.json'), JSON.stringify({ fixture: { expiry: Date.now() + 3600000, role: 'owner' } }));
const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port; await new Promise(r => reservation.close(r));
const proc = spawn(process.execPath, ['chat-server.mjs'], { env: { ...process.env, CHAT_PORT: String(port), SECURE_COOKIES: '0',
  REMOTELAB_MACHINE_CODEX_HOME: join(home, '.codex'), REMOTELAB_MEMORY_WRITEBACK: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
const ready = new Promise((resolve, reject) => {
  proc.stdout.on('data', c => { logs += c; if (logs.includes('Chat server listening')) resolve(); });
  proc.stderr.on('data', c => { logs += c; });
  proc.once('exit', () => reject(Error(logs)));
});
const timer = setTimeout(() => proc.kill('SIGKILL'), 20000);
const base = `http://127.0.0.1:${port}`;
const headers = { Cookie: 'session_token=fixture' };
try {
  await ready;
  const path = '/api/monitoring/prompt-review';
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(base + path + '/source?id=x')).status, 401);
  assert.equal((await fetch(base + path + '/run', { method: 'POST' })).status, 401);
  const response = await fetch(base + path, { headers });
  assert.equal(response.status, 200);
  const state = await response.json(); assert.equal(state.state, 'not_started'); assert.equal(state.config.enabled, false);
  const bad = await fetch(base + path + '/source?id=../../auth.json', { headers }); assert.equal(bad.status, 404);
  assert.equal((await fetch(base + path + '/run', { method: 'POST', headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const launch = await fetch(base + path + '/run', { method: 'POST', headers });
  assert.equal(launch.status, 202); assert.equal((await launch.json()).state, 'disabled');
  const page = await (await fetch(base + '/?tab=tasks&monitor=security', { headers })).text();
  assert.ok(page.includes('id="monitoringSecurityTab"') && page.includes('id="promptReviewContent"'));
  const js = await (await fetch(base + '/chat/monitoring.js', { headers })).text();
  assert.ok(js.includes('loadSecurity'));
  console.log('Authenticated Prompt review HTTP, disabled admission, source allowlist, CSRF and native Monitor entry passed.');
} finally {
  clearTimeout(timer); proc.kill('SIGTERM'); await once(proc, 'exit'); await rm(home, { recursive: true, force: true });
}
