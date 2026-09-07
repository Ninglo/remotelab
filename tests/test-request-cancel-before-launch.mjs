import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'request-cancel-'));
process.env.REMOTELAB_CONFIG_DIR = root;
const { requests } = await import('../chat/requests.mjs');
const manager = await import('../chat/session-manager.mjs');
try {
  const session = await manager.createSession(root, 'codex', 'Queued cancellation');
  const { record } = await requests.accept({ sessionId: session.id, requestId: 'cancel-before-launch', text: 'must not execute' });
  const cancelled = await manager.cancelActiveRun(session.id);
  assert.ok(cancelled, 'accepted requests are cancellable before Run preparation');
  await manager.startDetachedRunObservers();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !(await requests.get(record.key)).result) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await requests.get(record.key)).result.state, 'cancelled');
  assert.ok(!(await readdir(join(root, 'chat-runs', record.runId))).includes('launch.json'), 'cancelled queued request never starts an executor');
  console.log('request cancellation: durable admission can be cancelled before any executor starts');
} finally { await manager.killAll(); await rm(root, { recursive: true, force: true }); }
