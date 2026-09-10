import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-spawn-command-'));
setIsolatedTestHome(home);
const requests = [];
let response = { session: { id: 'child-1', name: 'Review' }, run: { id: 'run-1', state: 'accepted' },
  sessionUrl: 'https://user.example/?session=child-1&tab=sessions' };
let status = 201;
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/?token=')) {
    res.writeHead(302, { 'Set-Cookie': 'session_token=test; Path=/' });
    res.end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  requests.push({ path: req.url, method: req.method, body: body ? JSON.parse(body) : null });
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
});
try {
  const { AUTH_FILE } = await import('../lib/config.mjs');
  await mkdir(join(home, '.config/remotelab'), { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify({ token: 'test-token' }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.REMOTELAB_SESSION_ID = 'parent';
  process.env.REMOTELAB_RUN_ID = 'parent-run';
  const { runSessionSpawnCommand } = await import('../lib/session-spawn-command.mjs');
  let output = '';
  const io = { stdout: { write: s => { output += s; } } };
  const taskFile = join(home, 'handoff with spaces.md');
  const task = 'Inspect the API.\nKeep literal $(whoami), `shell` and $HOME as task text.';
  await writeFile(taskFile, task);
  assert.equal(await runSessionSpawnCommand(['--task-file', taskFile, '--json', '--base-url', base], io), 0);
  assert.deepEqual(requests, [{ path: '/api/sessions/parent/delegate', method: 'POST', body: { task, sourceRunId: 'parent-run' } }],
    'default creation admits once without polling and preserves the handoff');
  const receipt = JSON.parse(output);
  assert.equal(receipt.state, 'accepted');
  assert.equal(receipt.sessionUrl, response.sessionUrl, 'use the server public link instead of the local API address');
  assert.equal(receipt.runId, 'run-1');
  assert.equal(receipt.sessionId, 'child-1');
  output = '';
  await runSessionSpawnCommand(['--source-session', 'other', '--task', 'Review', '--json', '--base-url', base], io);
  assert.equal(requests.at(-1).body.sourceRunId, undefined, 'switching source must not carry an unrelated run');
  await runSessionSpawnCommand(['--source-session', 'other', '--source-run', 'other-run', '--task', 'Review', '--json', '--base-url', base], io);
  assert.equal(requests.at(-1).body.sourceRunId, 'other-run');
  await assert.rejects(runSessionSpawnCommand(['--task', 'one', '--task-file', taskFile], io), /only one/);
  const count = requests.length;
  output = '';
  await runSessionSpawnCommand(['--guide'], io);
  assert.match(output, /Visible RemoteLab delegation/);
  assert.equal(requests.length, count, 'guide has no HTTP side effects');
  for (const broken of [{ status: 400, body: { error: 'admission rejected' } },
    { status: 201, body: { session: { id: 'orphan' } } }]) {
    status = broken.status;
    response = broken.body;
    output = '';
    await assert.rejects(runSessionSpawnCommand(['--task', 'Review', '--json', '--base-url', base], io));
    assert.equal(output, '', 'failed or incomplete admission must not print a success receipt');
  }
  console.log('test-session-spawn-command: ok');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
