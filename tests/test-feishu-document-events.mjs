import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
try {
  controller = await startDocumentBindingEvents(runtime);
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
  await controller.recover();
  await controller.idle();
  assert.equal(reads, afterEvent + 1);
  assert.equal(submissions, 1, 'reconnect read preserves input deduplication');
  await controller.stop();
  controller = await startDocumentBindingEvents(runtime);
  await controller.idle();
  assert.equal(submissions, 1);
  console.log('document events: startup, no idle remote reads, bound dispatch, event dedupe, reconnect and restart passed');
} finally { await controller?.stop(); await rm(storageDir, { recursive: true, force: true }); }
