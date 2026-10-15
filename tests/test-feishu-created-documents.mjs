import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createdDocumentFromResult, recordCreatedDocument, readCreatedDocument } from '../lib/feishu-document-creation.mjs';
import { startDocumentBindingEvents, readBindingJson, writeBindingJson, bindingsDirectory, bindingKey } from '../connectors/feishu/document-bindings.mjs';
import { ensureCreatedDocumentBinding } from '../connectors/feishu/created-document-bindings.mjs';
import { resolveSessionDeliveryPlan } from '../chat/session-conversations.mjs';

const result = { ok: true, identity: 'bot', data: { document: { document_id: 'doc', url: 'https://example.feishu.cn/docx/doc' } } };
assert.equal(createdDocumentFromResult(['--profile', 'bot', 'docs', '+create'], result).fileToken, 'doc');
assert.equal(createdDocumentFromResult(['docs', '+create'], { ...result, identity: 'user' }), null);
assert.equal(createdDocumentFromResult(['docs', '+fetch'], result), null);
assert.equal(createdDocumentFromResult(['docs', '+update', '--content', 'docs +create'], result), null);
assert.equal(createdDocumentFromResult(['docs', '+create', '--dry-run'], result), null);
assert.equal(createdDocumentFromResult(['api', 'POST', '/open-apis/docx/v1/documents'], result).fileToken, 'doc');

const root = await mkdtemp(join(tmpdir(), 'created-documents-'));
const config = { storageDir: root, configDir: root, appId: 'app', sourceRouteId: 'bot', sessionTool: 'codex' };
const sessions = new Map([['creator', { id: 'creator', conversation: null }]]);
const submissions = [], sessionPayloads = [], replies = new Map();
const foreign = new Set(['unknown']);
let controller, lostAck = false;
const runtime = {
  config, botIdentity: { openId: 'bot-id' },
  appClient: { drive: { v1: {
    meta: { batchQuery: async ({ data }) => ({ data: { metas: data.request_docs.map(doc => ({
      doc_token: doc.doc_token, owner_id: foreign.has(doc.doc_token) ? 'somebody-else' : 'bot-id', title: 'Document',
    })) } }) },
    fileComment: { list: async ({ path }) => ({ data: { items: [{ comment_id: 'c', replies: [] }] } }) },
    fileCommentReply: { list: async ({ path }) => ({ data: { items: replies.get(path.file_token) || [] } }) },
  }, v2: { commentReaction: { updateReaction: async () => ({ code: 0 }) } } } },
  requestRemoteLab: async (path, options) => {
    if (path === '/api/sessions') {
      sessionPayloads.push(options.body);
      let session = [...sessions.values()].find(s => s.externalTriggerId === options.body.externalTriggerId);
      if (!session) { session = { ...options.body, id: `new-${sessions.size}` }; sessions.set(session.id, session); }
      if (lostAck) { lostAck = false; throw new Error('Lost creation acknowledgement'); }
      return { response: { ok: true }, json: { session } };
    }
    const id = path.split('/')[3];
    if (options) {
      const delivery = resolveSessionDeliveryPlan(sessions.get(id), options.body);
      submissions.push({ id, payload: options.body, delivery });
      return { response: { status: 202 }, json: { queued: true } };
    }
    return { response: { ok: sessions.has(id), status: sessions.has(id) ? 200 : 404 }, json: { session: sessions.get(id) } };
  },
};
const event = (token, id = token, commentId = 'c') => ({ fileToken: token, fileType: 'docx', commentId,
  replyId: 'r', eventId: id, messageId: id, sender: { openId: 'human' }, mentionedBot: false });
const reply = (id, author = 'human') => ({ reply_id: id, user_id: author,
  create_time: Math.floor(Date.now() / 1000) + 1,
  content: { elements: [{ type: 'text_run', text_run: { text: '请回复这条评论' } }] } });
const register = (token, sessionId = '') => recordCreatedDocument({ fileToken: token, fileType: 'docx' },
  { appId: 'app', sessionId, configDir: root });
const bindingPath = token => join(bindingsDirectory(root), `${bindingKey(token)}.binding.json`);
try {
  await register('doc', 'creator');
  await register('doc', 'different');
  assert.equal((await readCreatedDocument('app', 'doc', root)).sessionId, 'creator', 'creation receipt is immutable');
  assert.equal(await readCreatedDocument('other-app', 'doc', root), null);
  replies.set('doc', [reply('r'), reply('self', 'bot-id')]);
  controller = await startDocumentBindingEvents(runtime);
  await controller.accept({ ...event('self-mention'), sender: { openId: 'bot-id' }, mentionedBot: true });
  await controller.idle();
  assert.equal(sessionPayloads.length, 0, 'Bot self-mentions cannot enter the legacy mention path');
  assert.equal(await controller.accept(event('unknown')), true);
  await controller.idle();
  assert.equal(submissions.length, 0, 'non-owned documents do not create work');
  assert.equal(await controller.accept(event('doc')), true);
  await controller.idle();
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].id, 'creator', 'Web creator Session retains ownership');
  assert.equal(submissions[0].delivery.target.commentId, 'c');
  assert.equal(sessionPayloads.length, 0, 'bound creation never creates another Session');
  await controller.accept(event('doc'));
  await controller.idle();
  assert.equal(submissions.length, 1, 'duplicate intake is not admitted twice');

  await register('orphan');
  replies.set('orphan', [reply('r')]);
  await controller.accept(event('orphan'));
  await controller.idle();
  assert.equal(sessionPayloads.length, 1);
  const orphanId = submissions.at(-1).id;
  replies.get('orphan').push(reply('second'));
  await controller.accept(event('orphan', 'another-event'));
  await controller.idle();
  assert.equal(sessionPayloads.length, 1, 'later comments reuse the same document Session');
  assert.equal(submissions.at(-1).id, orphanId);
  await controller.stop();
  controller = await startDocumentBindingEvents(runtime);
  await controller.accept(event('orphan', 'after-restart'));
  await controller.idle();
  assert.equal(submissions.length, 3, 'restart keeps comment cursor');

  const bound = await readBindingJson(bindingPath('doc'));
  await writeBindingJson(bindingPath('doc'), { ...bound, enabled: false });
  await controller.accept(event('doc', 'disabled'));
  await controller.idle();
  assert.equal(submissions.length, 3, 'unbind does not fall through to another intake');
  await register('explicit', 'missing-creator');
  await writeBindingJson(bindingPath('explicit'), { ...bound, fileToken: 'explicit' });
  assert.equal((await ensureCreatedDocumentBinding(runtime, event('explicit'))).sessionId, 'creator');

  await register('lost');
  lostAck = true;
  await assert.rejects(ensureCreatedDocumentBinding(runtime, event('lost', 'first', 'first-comment')), /Lost creation/);
  const recovered = await ensureCreatedDocumentBinding(runtime, event('lost', 'later', 'another-comment'));
  assert.deepEqual(sessionPayloads.at(-1), sessionPayloads.at(-2), 'retry retains the exact creation intent');
  assert.equal(recovered.conversation.target.commentId, 'first-comment');
  assert.equal([...sessions.values()].filter(s => s.externalTriggerId?.endsWith(':lost')).length, 1);

  replies.set('legacy', [{ ...reply('old'), create_time: 1000 }, reply('r')]);
  await controller.accept(event('legacy'));
  await controller.idle();
  assert.equal(submissions.at(-1).payload.sourceContext.fileToken, 'legacy');
  assert.equal(submissions.filter(s => s.payload.sourceContext.fileToken === 'legacy').length, 1,
    'Bot-owned historical documents start at the triggering comment, not old history');
  foreign.add('legacy');
  replies.get('legacy').push(reply('after-transfer'));
  await controller.accept(event('legacy', 'transferred'));
  await controller.idle();
  assert.equal(submissions.filter(s => s.payload.sourceContext.fileToken === 'legacy').length, 1,
    'automatic intake stops when the Bot no longer owns the document');

  await register('missing', 'missing-creator');
  await assert.rejects(ensureCreatedDocumentBinding(runtime, event('missing')), /creator Session unavailable/);
  assert.equal(await readBindingJson(bindingPath('missing')), null, 'missing explicit target is not replaced');
  console.log('Created documents: provenance, creator routing, unbound creation/reuse, restart, duplicate, Bot isolation, explicit binding and lost ACK passed');
} finally {
  await controller?.stop();
  await rm(root, { recursive: true, force: true });
}
