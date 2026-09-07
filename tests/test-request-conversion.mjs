import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeDurableJson } from '../lib/durable-records.mjs';
import { createRequestStore } from '../chat/requests.mjs';
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'request-conversion-'));
const source = join(root, 'source');
const output = join(root, 'converted');
try {
  await mkdir(source);
  const id = 'run_000000000000000000000001';
  const status = { id, sessionId: 'session-1', requestId: 'upstream-1', responseId: 'response-1', state: 'running' };
  await writeDurableJson(join(source, 'chat-runs', id, 'status.json'), status);
  await writeDurableJson(join(source, 'chat-runs', id, 'manifest.json'), { prompt: 'original input', tool: 'fake', options: {} });
  await writeDurableJson(join(source, 'chat-sessions.json'), [{ id: 'session-1', activeRunId: id,
    followUpQueue: [{ requestId: 'pending-1', text: 'next input' }] }]);
  await writeDurableJson(join(source, 'chat-source-deliveries.json'), [{ id: 'old-outbox', connector: 'feishu',
    sourceRouteId: 'default', sessionId: 'session-1', target: { chatId: 'chat-1' }, state: 'sending', text: 'old answer' }]);
  await assert.rejects(exec(process.execPath, ['scripts/convert-request-state.mjs', '--source', source, '--output', join(root, 'refused')]), /Unfinished attempts require explicit disposition/);
  await exec(process.execPath, ['scripts/convert-request-state.mjs', '--source', source, '--output', output, '--interrupt-unfinished']);
  assert.deepEqual(JSON.parse(await readFile(join(source, 'chat-runs', id, 'status.json'), 'utf8')), status, 'source remains untouched');
  const store = createRequestStore(join(output, 'requests'));
  const migrated = await store.byRunId(id);
  assert.equal(migrated.runId, id);
  assert.equal(migrated.result.state, 'failed');
  assert.match(migrated.result.error, /interrupted/);
  assert.equal((await store.byResponse('session-1', 'response-1')).key, migrated.key);
  assert.equal((await store.byRequest('session-1', 'pending-1')).text, 'next input');
  const deliveries = (await store.active()).flatMap(record => record.deliveries);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].state, 'unknown', 'old uncertain sends cannot be retried blindly');
  assert.equal(JSON.parse(await readFile(join(output, 'requests', 'schema.json'), 'utf8')).version, 1);
  console.log('conversion: no source writes, explicit interruption, preserved IDs/queue and unknown delivery');
} finally { await rm(root, { recursive: true, force: true }); }
