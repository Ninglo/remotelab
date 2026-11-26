import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createdDocumentFromResult, recordCreatedDocument, readCreatedDocument } from '../lib/feishu-document-creation.mjs';
import { startDocumentBindingEvents, readBindingJson, writeBindingJson, bindingsDirectory, bindingKey } from '../connectors/feishu/document-bindings.mjs';
import { ensureDocumentBinding } from '../connectors/feishu/created-document-bindings.mjs';
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
  allowDocumentMention: async summary => summary.sender.openId !== 'blocked',
  appClient: { drive: { v1: {
    meta: { batchQuery: async ({ data }) => ({ data: { metas: data.request_docs.map(doc => ({
      doc_token: doc.doc_token, owner_id: foreign.has(doc.doc_token) ? 'somebody-else' : 'bot-id', title: 'Document',
    })) } }) },
    fileComment: {
      batchQuery: async ({ data }) => ({ data: { items: data.comment_ids.map(comment_id => ({ comment_id })) } }),
    },
    fileCommentReply: { list: async ({ path }) => ({ data: { items: replies.get(path.file_token) || [reply('r')] } }) },
  }, v2: { commentReaction: { updateReaction: async () => ({ code: 0 }) } } } },
  requestRemoteLab: async (path, options) => {
    if (path === '/api/sessions') {
      sessionPayloads.push(options.body);
      let session = [...sessions.values()].find(s => s.externalTriggerId === options.body.externalTriggerId);
      if (!session) { session = { ...options.body, id: `new-${sessions.size}` }; sessions.set(session.id, session); }
      if (lostAck) { lostAck = false; throw new Error('Lost creation acknowledgement'); }
      return { response: { ok: true }, json: { session } };
    }
    assert.ok(path.startsWith('/api/sessions/'));
    const id = path.split('/')[3];
    if (options) {
      if (!sessions.has(id) || sessions.get(id).archived) return { response: { status: 404 } };
      const delivery = resolveSessionDeliveryPlan(sessions.get(id), options.body);
      submissions.push({ id, payload: options.body, delivery });
      return { response: { status: 202 }, json: { queued: true } };
    }
    return { response: { ok: sessions.has(id), status: sessions.has(id) ? 200 : 404 }, json: { session: sessions.get(id) } };
  },
};
const event = (token, id = token, commentId = 'c') => ({ fileToken: token, fileType: 'docx', commentId,
  replyId: 'r', eventId: id, messageId: id, sender: { openId: 'human' }, mentionedBot: true });
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
  for (const token of ['unknown', 'doc', 'never-bound']) {
    assert.equal(await controller.accept({ ...event(token), mentionedBot: false }), true);
  }
  await controller.idle();
  assert.equal(submissions.length, 0, 'unmentioned comments do not create work, even in Bot-owned docs');
  assert.equal(await readBindingJson(bindingPath('doc')), null);
  assert.equal(sessionPayloads.length, 0);
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
  await controller.accept({ ...event('orphan', 'another-event'), replyId: 'second' });
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
  assert.equal((await ensureDocumentBinding(runtime, event('explicit'))).sessionId, 'creator');

  await register('lost');
  lostAck = true;
  await assert.rejects(ensureDocumentBinding(runtime, event('lost', 'first', 'first-comment')), /Lost creation/);
  const recovered = await ensureDocumentBinding(runtime, event('lost', 'later', 'another-comment'));
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
  await controller.accept({ ...event('legacy', 'transferred'), replyId: 'after-transfer' });
  await controller.idle();
  assert.equal(submissions.filter(s => s.payload.sourceContext.fileToken === 'legacy').length, 1,
    'automatic intake stops when the Bot no longer owns the document');

  await register('missing', 'missing-creator');
  await assert.rejects(ensureDocumentBinding(runtime, event('missing')), /creator Session unavailable/);
  assert.equal(await readBindingJson(bindingPath('missing')), null, 'missing explicit target is not replaced');

  foreign.add('denied');
  const createsBeforeMentions = sessionPayloads.length;
  await controller.accept({ ...event('denied'), mentionedBot: true, sender: { openId: 'blocked' } });
  await controller.idle();
  assert.equal(await readBindingJson(bindingPath('denied')), null);
  const mentionsBefore = submissions.length;
  const mention = (thread, mentionedBot = true) => ({ ...event('unknown', thread, thread),
    sourceKind: 'document_comment', mentionedBot });
  await controller.accept(mention('first'));
  await controller.idle();
  await controller.stop();
  controller = await startDocumentBindingEvents(runtime);
  await controller.accept(mention('silent', false));
  await controller.accept(mention('second'));
  await controller.accept(mention('second'));
  await controller.idle();
  assert.equal(sessionPayloads.length, createsBeforeMentions + 1, 'one Session across both comment threads and restart');
  const fixed = await readBindingJson(bindingPath('unknown'));
  assert.equal(fixed.mentionOnly, true);
  assert.deepEqual(submissions.slice(mentionsBefore).map(s => [s.id, s.delivery.target.commentId]),
    [[fixed.sessionId, 'first'], [fixed.sessionId, 'second']]);
  assert.ok(submissions.at(-1).payload.sourceContext.documentBinding);
  sessions.delete(fixed.sessionId);
  await controller.accept(mention('missing-target'));
  await controller.idle();
  assert.equal(sessionPayloads.length, createsBeforeMentions + 1, 'missing target never creates a substitute');
  assert.equal((await readBindingJson(bindingPath('unknown'))).sessionId, fixed.sessionId);
  await writeBindingJson(bindingPath('unknown'), { ...fixed, enabled: false });
  await controller.accept(mention('disabled-target'));
  await controller.idle();
  assert.equal(sessionPayloads.length, createsBeforeMentions + 1, 'disabling an existing binding never reassigns it');
  console.log('Created documents: provenance, creator routing, unbound creation/reuse, restart, duplicate, Bot isolation, explicit binding and lost ACK passed');
} finally {
  await controller?.stop();
  await rm(root, { recursive: true, force: true });
}
