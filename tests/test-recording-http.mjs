import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { createRemoteLabHttpClient } from '../lib/remotelab-http-client.mjs';
import { normalizeAuthDocument } from '../lib/auth-config.mjs';
import { normalizeRecordingConfig } from '../lib/recording/config.mjs';
import { WavWriter } from '../lib/recording/pcm.mjs';
import { recordDir, saveRecord, loadRecord } from '../lib/recording/store.mjs';
import { submitRecording } from '../lib/recording/transport.mjs';

async function availablePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
function terminalRun(client, ws, runId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(Error('Recording Run did not finish')); }, 15000);
    let checking = false, dirty = false;
    const cleanup = () => { clearTimeout(timer); ws.removeListener('message', changed); };
    const check = async () => {
      if (checking) { dirty = true; return; } checking = true;
      try {
        do {
          dirty = false;
          const response = await client.request(`/api/runs/${runId}`, { signal: AbortSignal.timeout(3000) });
          const run = response.json?.run;
          if (['completed', 'failed', 'cancelled'].includes(run?.state)) { cleanup(); resolve(run); return; }
        } while (dirty);
      } catch (error) { cleanup(); reject(error); }
      finally { checking = false; }
    };
    const changed = () => { check(); };
    ws.on('message', changed); check();
  });
}

test('saved audio enters the real RemoteLab asset/message/Run path and a lost reply cannot create a duplicate turn', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remotelab-recording-http-'));
  const configDir = join(root, 'config'), bin = join(root, 'bin'), promptPath = join(root, 'prompt.txt');
  await mkdir(configDir); await mkdir(bin);
  const token = '0123456789abcdef'.repeat(4);
  await writeFile(join(configDir, 'auth.json'), JSON.stringify({ ...normalizeAuthDocument({ token: 'c'.repeat(64) }), serviceToken: token }));
  await writeFile(join(configDir, 'tools.json'), JSON.stringify([{ id: 'fake-codex', name: 'Recording test', command: join(bin, 'fake-codex'), runtimeFamily: 'codex-json', models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }], reasoning: { kind: 'enum', levels: ['low'], default: 'low' } }]));
  await writeFile(join(bin, 'fake-codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = process.argv[process.argv.length - 1] || '';
// The post-turn classifier passes its prompt on stdin ('-'). Its background
// invocation must not overwrite the foreground recording prompt under test.
if (prompt !== '-') fs.writeFileSync(process.env.REMOTELAB_FAKE_PROMPT_FILE, prompt);
console.log(JSON.stringify({type:'thread.started', thread_id:'recording-test-thread'}));
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'录音附件已进入测试 Harness'}}));
console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:1,output_tokens:1}}));
`);
  await chmod(join(bin, 'fake-codex'), 0o755);
  const port = await availablePort();
  const child = spawn(process.execPath, ['chat-server.mjs'], { cwd: resolve('.'), env: { ...process.env,
    HOME: root, REMOTELAB_CONFIG_DIR: configDir, REMOTELAB_MEMORY_DIR: join(root, 'memory'),
    REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER: '1', REMOTELAB_FAKE_PROMPT_FILE: promptPath,
    CHAT_PORT: String(port), CHAT_BIND_HOST: '127.0.0.1', SECURE_COOKIES: '0',
    REMOTELAB_ASSET_STORAGE_BASE_URL: '', REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL: '', REMOTELAB_ASSET_STORAGE_PROVIDER: '', REMOTELAB_ASSET_STORAGE_REGION: '', REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID: '', REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (s) => { output += s; }); child.stderr.on('data', (s) => { output += s; });
  const lines = createInterface({ input: child.stdout });
  let ws;
  t.after(async () => {
    lines.close(); ws?.terminate();
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Server startup: ' + output)), 10000);
    const ready = (line) => { if (line.includes('Chat server listening on')) { clearTimeout(timer); lines.removeListener('line', ready); resolve(); } };
    lines.on('line', ready); child.once('exit', (code) => { clearTimeout(timer); reject(Error('Server exited: ' + code + '\n' + output)); });
  });
  const client = createRemoteLabHttpClient({ baseUrl: `http://127.0.0.1:${port}`, authToken: token });
  const cookie = await client.ensureAuthCookie(); ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } }); await once(ws, 'open');
  const spool = join(root, 'recording');
  const record = { id: 'rec_' + 'a'.repeat(32), machineId: 'http_test_machine', laneId: 'a', receiverId: 'rx1', channel: 0,
    label: '独立讨论 A', status: 'pending', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    destination: {}, session: { tool: 'fake-codex', folder: root }, baseUrl: client.baseUrl, segments: [{ filename: '00000.wav' }] };
  await saveRecord(spool, record);
  const writer = new WavWriter(join(recordDir(spool, record.id), '00000.wav')); await writer.start(); await writer.append(Buffer.from([123, 0, 124, 0])); await writer.finish();
  const config = normalizeRecordingConfig({ limits: { uploadBytesPerSecond: 1024 * 1024 } });
  let loseReply = true;
  const unreliable = { ...client, request: async (path, options) => {
    const result = await client.request(path, options);
    if (path.endsWith('/messages') && loseReply && result.response.ok) { loseReply = false; throw Error('Accepted reply lost'); }
    return result;
  } };
  await assert.rejects(submitRecording(spool, record, { config, client: unreliable }), /reply lost/);
  const saved = await loadRecord(spool, record.id);
  assert.ok(saved.requestId); assert.ok(saved.sessionId); assert.equal(saved.status, 'pending');
  await submitRecording(spool, saved, { config, client });
  assert.equal(saved.status, 'submitted'); assert.ok(saved.runId);
  const run = await terminalRun(client, ws, saved.runId); assert.equal(run.state, 'completed', output);
  const events = (await client.request(`/api/sessions/${saved.sessionId}/events`)).json.events;
  const users = events.filter((e) => e.role === 'user' || e.type === 'user');
  assert.equal(users.length, 1, JSON.stringify(events));
  assert.equal(users[0].sourceContext?.recordingId, record.id);
  assert.equal(users[0].sourceContext?.channel, 0);
  const asset = (await client.request(`/api/assets/${saved.segments[0].assetId}`)).json.asset;
  assert.equal(asset.status, 'ready'); assert.equal(asset.mimeType, 'audio/wav'); assert.equal(asset.sizeBytes, 48);
  const prompt = await readFile(promptPath, 'utf8');
  assert.match(prompt, /独立讨论 A/); assert.match(prompt, /audio\/wav|\.wav/); assert.match(prompt, /远端转写/);
  assert.ok(prompt.includes(saved.segments[0].assetId) || prompt.includes(record.id), 'Harness must receive the recording attachment source');
  const bound = { ...record, id: 'rec_' + 'b'.repeat(32), laneId: 'b', channel: 1, label: '独立讨论 B', status: 'pending',
    destination: { conversation: { connector: 'feishu', sourceRouteId: 'recording-test-route', target: {
      chatId: 'recording-test-chat', conversationKind: 'topic', threadId: 'recording-thread', rootId: 'recording-root',
    } } }, segments: [{ filename: '00000.wav' }] };
  delete bound.sessionId; delete bound.requestId; delete bound.runId; delete bound.submittedAt;
  await saveRecord(spool, bound);
  const second = new WavWriter(join(recordDir(spool, bound.id), '00000.wav')); await second.start(); await second.append(Buffer.from([42, 0])); await second.finish();
  await submitRecording(spool, bound, { config, client });
  assert.notEqual(bound.sessionId, saved.sessionId);
  const boundRun = await terminalRun(client, ws, bound.runId); assert.equal(boundRun.state, 'completed', output);
  const delivery = (await client.request('/api/source-deliveries?connector=feishu&sourceRouteId=recording-test-route')).json.deliveries.find((d) => d.runId === bound.runId && d.kind === 'content');
  assert.ok(delivery, 'Completed analysis must retain the lane-bound delivery');
  assert.equal(delivery.target.chatId, 'recording-test-chat'); assert.equal(delivery.target.threadId, 'recording-thread');
  assert.equal(delivery.state, 'pending', 'No real Connector sends are performed in this test');
});
