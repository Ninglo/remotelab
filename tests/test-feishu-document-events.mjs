import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnectorInbox } from '../lib/connector-inbox.mjs';
import { startDocumentBindingEvents, bindingsDirectory, bindingKey, writeBindingJson } from '../connectors/feishu/document-bindings.mjs';

const storageDir = await mkdtemp(join(tmpdir(), 'document-events-'));
const binding = { enabled: true, generation: 'g', fileToken: 'doc', fileType: 'docx',
  sessionId: 'review', sourceRouteId: 'bot', since: '2020-01-01T00:00:00Z',
  conversation: { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'chat', threadId: 'topic' } } };
const directory = bindingsDirectory(storageDir);
await writeBindingJson(join(directory, `${bindingKey('doc')}.binding.json`), binding);
// A leftover cooldown from the old implementation must not schedule a scan.
await writeBindingJson(join(directory, 'recovery-state.json'), { nextAt: 0 });
let reads = 0, submissions = 0, sessionReads = 0;
const replies = [];
const runtime = { config: { storageDir, sourceRouteId: 'bot' }, botIdentity: { openId: 'bot' },
  appClient: { drive: { v1: {
    fileComment: { list: async () => { reads++; return { data: { items: [{ comment_id: 'c' }] } }; } },
    fileCommentReply: { list: async () => { reads++; return { data: { items: replies } }; } },
  } } },
  requestRemoteLab: async (_path, options) => {
    if (!options) { sessionReads++; return { response: { ok: true }, json: { session: { conversation: binding.conversation } } }; }
    submissions++;
    return { response: { status: 202 }, json: { queued: true } };
  },
};
const reply = (id, text) => ({ reply_id: id, user_id: 'human', create_time: 1789690010,
  content: { elements: [{ type: 'text_run', text_run: { text } }] } });
let controller;
try {
  controller = await startDocumentBindingEvents(runtime);
  await controller.idle();
  assert.equal(reads, 0, 'startup with an existing binding never queries Feishu');
  assert.equal(sessionReads, 0, 'startup does not reconcile bound Sessions either');
  for (let i = 0; i < 10; i++) await controller.idle();
  assert.equal(reads, 0, 'local inbox ticks never scan documents without received events');
  assert.equal(await controller.accept({ fileToken: 'unbound', eventId: 'ignore' }), false);

  const newlyBound = { ...binding, generation: 'new', fileToken: 'new-doc' };
  await writeBindingJson(join(directory, `${bindingKey('new-doc')}.binding.json`), newlyBound);
  await controller.idle();
  assert.equal(reads, 0, 'declaring a new binding does not read comments');
  replies.push(reply('r', 'review'));
  assert.equal(await controller.accept({ fileToken: 'new-doc', eventId: 'new-binding-event' }), true);
  await controller.idle();
  assert.equal(submissions, 1, 'a newly bound document still handles its actual event');
  assert.equal(reads, 2, 'one event reads the comment list and its reply thread');
  await controller.accept({ fileToken: 'new-doc', eventId: 'new-binding-event' });
  await controller.idle();
  assert.equal(reads, 2, 'duplicate events do not read again');

  for (let i = 0; i < 4; i++) {
    await controller.stop();
    controller = await startDocumentBindingEvents(runtime);
    await controller.idle();
  }
  assert.equal(reads, 2, 'repeated connector starts do not scan any bound document');
  assert.equal(submissions, 1);
  await controller.stop();

  // Simulate received events that were persisted before the process stopped,
  // together with a delayed legacy recovery and a binding-change scan.
  const persisted = createConnectorInbox(join(directory, 'events'), {
    process: async () => { throw new Error('seeding inbox must not dispatch'); },
    conversationKey: entry => entry.fileToken,
  });
  const recovery = await persisted.accept('recover:g:old', { fileToken: 'doc' });
  await persisted.store.mutate(recovery.key, current => ({ ...current, nextAttemptAt: Date.now() + 60_000 }));
  const bindScan = await persisted.accept('bind:g', { fileToken: 'doc' });
  const event = await persisted.accept('comment:received-before-stop', { fileToken: 'doc' });
  controller = await startDocumentBindingEvents(runtime);
  await controller.idle();
  assert.equal(reads, 4, 'only the persisted real comment event resumes after restart');
  assert.equal(submissions, 2);
  for (const scan of [recovery, bindScan]) {
    const receipt = await persisted.store.get(scan.key);
    assert.equal(receipt.complete, true);
    assert.equal(receipt.receipt.ignored, 'automatic_scan_disabled', 'legacy scans are retired without requests');
  }
  assert.equal((await persisted.store.get(event.key)).receipt.reconciled, true);
  assert.equal((await persisted.store.active()).length, 0, 'a delayed old scan cannot block actual comment events');
  await controller.accept({ fileToken: 'doc', eventId: 'received-before-stop' });
  await controller.idle();
  assert.equal(reads, 4, 'persisted event receipts prevent replay after restart');

  replies.push(reply('no-event', 'not notified'));
  await controller.stop();
  controller = await startDocumentBindingEvents(runtime);
  await controller.idle();
  assert.equal(reads, 4, 'comments without a received event do not cause startup reads');
  assert.equal(submissions, 2);
  await controller.accept({ fileToken: 'doc', eventId: 'actual-new-comment' });
  await controller.idle();
  assert.equal(submissions, 3, 'later real events still process new comments once');
  assert.equal(reads, 6);
  await controller.stop();

  let forbiddenReads = 0;
  const forbiddenRuntime = { ...runtime, appClient: { drive: { v1: {
    fileComment: { list: async () => { forbiddenReads++; return { code: 99991672, msg: 'permission required' }; } },
  } } } };
  controller = await startDocumentBindingEvents(forbiddenRuntime);
  await controller.idle();
  assert.equal(forbiddenReads, 0);
  await controller.accept({ fileToken: 'doc', eventId: 'permission-event' });
  await controller.idle();
  assert.equal(forbiddenReads, 1);
  const blocked = JSON.parse(await readFile(join(directory, `${bindingKey('doc')}.state.json`), 'utf8'));
  assert.equal(blocked.retryBlocked, true);
  assert.equal(blocked.retryBlockedCode, 99991672);
  await controller.accept({ fileToken: 'doc', eventId: 'new-event-without-permission' });
  await controller.idle();
  await controller.stop();
  controller = await startDocumentBindingEvents(forbiddenRuntime);
  await controller.idle();
  assert.equal(forbiddenReads, 1, 'permanent failures do not make API calls after a new event or restart');
  console.log('document events: zero startup/binding scans, actual events, durable event resume, legacy scan retirement, deduplication and permanent rejection passed');
} finally { await controller?.stop(); await rm(storageDir, { recursive: true, force: true }); }
