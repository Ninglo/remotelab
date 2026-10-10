import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDocumentBindingEvents, bindingsDirectory, bindingKey, writeBindingJson } from '../connectors/feishu/document-bindings.mjs';

const storageDir = await mkdtemp(join(tmpdir(), 'document-events-'));
const binding = { enabled: true, generation: 'g', fileToken: 'doc', fileType: 'docx',
  sessionId: 'review', sourceRouteId: 'bot', since: '2020-01-01T00:00:00Z',
  conversation: { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'chat', threadId: 'topic' } } };
await writeBindingJson(join(bindingsDirectory(storageDir), `${bindingKey('doc')}.binding.json`), binding);
let reads = 0, submissions = 0;
const replies = [];
const runtime = { config: { storageDir, sourceRouteId: 'bot' }, botIdentity: { openId: 'bot' },
  appClient: { drive: { v1: {
    fileComment: { list: async () => { reads++; return { data: { items: [{ comment_id: 'c' }] } }; } },
    fileCommentReply: { list: async () => ({ data: { items: replies } }) },
  } } },
  requestRemoteLab: async (_path, options) => {
    if (!options) return { response: { ok: true }, json: { session: { conversation: binding.conversation } } };
    submissions++;
    return { response: { status: 202 }, json: { queued: true } };
  },
};
let controller;
let clock = 100_000, nextTimer = 0;
const timers = new Map();
const recoveryOptions = { now: () => clock,
  schedule: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, at: clock + delay }); return id; },
  cancel: id => timers.delete(id) };
const advanceRecovery = async () => {
  for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
  await controller.idle();
};
try {
  controller = await startDocumentBindingEvents(runtime, recoveryOptions);
  await controller.idle();
  assert.equal(reads, 1, 'one startup reconciliation');
  for (let i = 0; i < 10; i++) await controller.idle();
  assert.equal(reads, 1, 'idle local inbox ticks never query Feishu');
  assert.equal(await controller.accept({ fileToken: 'unbound', eventId: 'ignore' }), false);
  replies.push({ reply_id: 'r', user_id: 'human', create_time: 1789690000, content: { elements: [{ type: 'text_run', text_run: { text: 'review' } }] } });
  assert.equal(await controller.accept({ fileToken: 'doc', eventId: 'e' }), true);
  await controller.idle();
  assert.equal(submissions, 1);
  const afterEvent = reads;
  await controller.accept({ fileToken: 'doc', eventId: 'e' });
  await controller.idle();
  assert.equal(reads, afterEvent, 'duplicate events do not read again');
  await Promise.all(Array.from({ length: 10 }, () => controller.recover()));
  await controller.idle();
  assert.equal(reads, afterEvent, 'a reconnect burst does not repeat remote reads');
  assert.equal(timers.size, 1, 'all reconnects share one trailing recovery, including timer ID zero');
  await controller.stop();
  assert.equal(timers.size, 0, 'shutdown cancels scheduled recovery');
  controller = await startDocumentBindingEvents(runtime, recoveryOptions);
  await controller.idle();
  assert.equal(reads, afterEvent, 'recovery cooldown survives process restart');
  replies.push({ reply_id: 'missed-during-gap', user_id: 'human', create_time: 1789690010,
    content: { elements: [{ type: 'text_run', text_run: { text: 'missed event' } }] } });
  clock += 30_000;
  await advanceRecovery();
  assert.equal(reads, afterEvent + 1, 'one trailing recovery catches a comment without its event');
  assert.equal(submissions, 2);
  await controller.recover();
  clock += 30_000;
  await advanceRecovery();
  assert.equal(submissions, 2, 'recovery preserves comment admission deduplication');
  await controller.stop();
  let forbiddenReads = 0;
  const forbiddenRuntime = { ...runtime, appClient: { drive: { v1: {
    fileComment: { list: async () => { forbiddenReads++; return { code: 99991672, msg: 'permission required' }; } },
  } } } };
  clock += 30_000;
  controller = await startDocumentBindingEvents(forbiddenRuntime, recoveryOptions);
  await controller.idle();
  assert.equal(forbiddenReads, 1);
  const blocked = JSON.parse(await readFile(join(bindingsDirectory(storageDir), `${bindingKey('doc')}.state.json`), 'utf8'));
  assert.equal(blocked.retryBlocked, true);
  assert.equal(blocked.retryBlockedCode, 99991672);
  await controller.accept({ fileToken: 'doc', eventId: 'new-event-without-permission' });
  await controller.idle();
  await controller.stop();
  clock += 30_000;
  controller = await startDocumentBindingEvents(forbiddenRuntime, recoveryOptions);
  await controller.idle();
  assert.equal(forbiddenReads, 1, 'permanent failures do not make API calls after a new event or restart');
  await controller.stop();
  const stormStorage = join(storageDir, 'storm');
  await writeBindingJson(join(bindingsDirectory(stormStorage), `${bindingKey('doc')}.binding.json`), binding);
  let releaseScan, markStarted, stormReads = 0;
  const scanGate = new Promise(resolve => { releaseScan = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const stormRuntime = { ...runtime, config: { ...runtime.config, storageDir: stormStorage },
    appClient: { drive: { v1: { fileComment: { list: async () => { stormReads++; return { data: { items: [] } }; } } } } },
    requestRemoteLab: async () => { markStarted(); await scanGate;
      return { response: { ok: true }, json: { session: { conversation: binding.conversation } } }; },
  };
  controller = await startDocumentBindingEvents(stormRuntime, recoveryOptions);
  await started;
  for (let i = 0; i < 20; i++) { clock += 30_000; await controller.recover(); }
  assert.equal((await readdir(join(bindingsDirectory(stormStorage), 'events', 'active'))).filter(name => name.endsWith('.json')).length, 2,
    'a prolonged reconnect storm retains only the in-flight scan and one trailing scan per document');
  releaseScan(); await controller.idle();
  assert.equal(stormReads, 2, 'bounded recovery backlog still performs its final catch-up');
  console.log('document events: immediate comments, burst/restart coalescing, trailing catch-up, deduplication and permanent rejection passed');
} finally { await controller?.stop(); await rm(storageDir, { recursive: true, force: true }); }
