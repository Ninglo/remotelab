import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnectorInbox } from '../lib/connector-inbox.mjs';
import { startDocumentBindingEvents, bindingsDirectory, bindingKey, documentBindingPath, writeBindingJson } from '../connectors/feishu/document-bindings.mjs';
import { summarizeFeishuDocumentCommentEvent } from '../connectors/feishu/comment-flow.mjs';

const storageDir = await mkdtemp(join(tmpdir(), 'document-events-'));
const binding = { enabled: true, generation: 'g', fileToken: 'doc', fileType: 'docx',
  sessionId: 'review', sourceRouteId: 'bot', replyMode: 'comment', since: '2020-01-01T00:00:00Z',
  conversation: { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'chat', threadId: 'topic' } } };
const directory = bindingsDirectory(storageDir);
const statePath = join(directory, `${bindingKey('doc')}.state.json`);
const event = (id, replyId, mentioned = true) => summarizeFeishuDocumentCommentEvent({
  event_id: id, comment_id: 'c', reply_id: replyId, is_mentioned: mentioned,
  notice_meta: { file_token: 'doc', file_type: 'docx', notice_type: 'add_reply', from_user_id: { open_id: 'human' } },
});
const reply = (id, person = 'human') => ({ reply_id: id, user_id: person, create_time: 1789690010,
  content: { elements: [{ type: 'text_run', text_run: { text: id } }] } });
const reads = [], submissions = [], reactions = [];
let sessionReads = 0;
const runtime = { config: { storageDir, sourceRouteId: 'bot', appId: 'app' }, botIdentity: { openId: 'bot' },
  appClient: { drive: { v1: {
    fileComment: { batchQuery: async ({ data }) => {
      reads.push(data.comment_ids);
      return { data: { items: [{ comment_id: 'c' }] } };
    } },
    fileCommentReply: { list: async ({ path }) => {
      reads.push(path.comment_id);
      return { data: { items: ['human-only', 'explicit-mention', 'untagged-follow-up', 'next-mention'].map(id => reply(id)) } };
    } },
  }, v2: { commentReaction: { updateReaction: async ({ data }) => { reactions.push(data); return { code: 0 }; } } } } },
  requestRemoteLab: async (_path, options) => {
    if (!options) { sessionReads++; return { response: { ok: true }, json: { session: { conversation: binding.conversation } } }; }
    submissions.push(options.body);
    return { response: { status: 202 }, json: { queued: true } };
  },
};
let controller;
try {
  await writeBindingJson(documentBindingPath(storageDir, 'doc'), binding);
  await writeBindingJson(join(directory, 'recovery-state.json'), { nextAt: 0 });
  await writeBindingJson(statePath, { seen: {}, generation: 'g', pending: [{ key: 'c:human-only', payload: { requestId: 'old-work' } }] });
  const persisted = createConnectorInbox(join(directory, 'events'), {
    process: async () => { throw new Error('seeding inbox must not dispatch'); }, conversationKey: entry => entry.fileToken,
  });
  const recovery = await persisted.accept('recover:g:old', { fileToken: 'doc' });
  await persisted.store.mutate(recovery.key, current => ({ ...current, nextAttemptAt: Date.now() + 60_000 }));
  const summaryless = await persisted.accept('comment:legacy-explicit', { fileToken: 'doc' });
  const unmentioned = await persisted.accept('comment:legacy-unmentioned', { fileToken: 'doc', summary: event('legacy-unmentioned', 'human-only', false) });
  controller = await startDocumentBindingEvents(runtime);
  await controller.idle();
  for (const old of [recovery, summaryless, unmentioned]) {
    const archived = await persisted.store.get(old.key);
    assert.equal(archived.complete, true);
    assert.equal(archived.receipt.ignored, 'mention_required');
  }
  assert.equal(await controller.accept(event('before', 'human-only', false)), true);
  await controller.idle();
  assert.equal(reads.length, 0, 'startup and ordinary comments do not query Feishu');
  assert.equal(sessionReads, 0, 'unmentioned events do not resolve a Session');
  assert.equal(reactions.length, 0);

  const actual = event('legacy-explicit', 'explicit-mention');
  await controller.accept(actual);
  await controller.accept(actual);
  await controller.idle();
  assert.deepEqual(reads, [['c'], 'c'], 'one @ reads only its thread, never the document comment list');
  assert.deepEqual(submissions.map(p => p.sourceDelivery.target.replyId), ['explicit-mention']);
  assert.deepEqual(reactions.map(({ reply_id, reaction_type }) => [reply_id, reaction_type]), [['explicit-mention', 'Get']]);
  assert.ok(submissions[0].sourceContext.commentThread.some(item => item.replyId === 'human-only' && !item.current));

  await controller.stop();
  const next = event('after-restart', 'next-mention');
  await persisted.accept('mention:after-restart', { fileToken: 'doc', summary: next });
  controller = await startDocumentBindingEvents(runtime);
  await controller.accept(event('follow-up', 'untagged-follow-up', false));
  await controller.accept(actual);
  await controller.idle();
  assert.deepEqual(reads, [['c'], 'c', ['c'], 'c']);
  assert.deepEqual(submissions.map(p => p.sourceDelivery.target.replyId), ['explicit-mention', 'next-mention']);
  assert.equal(reactions.length, 2, 'same-thread follow-ups still need a fresh @');
  assert.equal((await persisted.store.active()).length, 0);
  console.log('document events: current mention only, no silent side effects, old queue retirement, restart and deduplication passed');
} finally { await controller?.stop(); await rm(storageDir, { recursive: true, force: true }); }
