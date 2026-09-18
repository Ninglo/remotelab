import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commentCandidates, reconcileDocumentBinding, readBindingJson, writeBindingJson, bindingKey, bindingsDirectory, readDocumentComments } from '../connectors/feishu/document-bindings.mjs';
import { canForwardNativeRequest } from '../chat/native-request-dispatch.mjs';
import { normalizeScheduledSessionTemplate, scheduledSessionIdentity } from '../lib/scheduled-session.mjs';

const storageDir = await mkdtemp(join(tmpdir(), 'document-bindings-'));
const binding = { generation: 'g', fileToken: 'doc', fileType: 'docx', documentUrl: 'https://example.feishu.cn/docx/doc',
  sessionId: 'session', sourceRouteId: 'bot', since: '2026-09-18T00:00:00Z',
  conversation: { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'chat', threadId: 'topic' } } };
const reply = (id, text, user = 'human', time = 1789690000) => ({ reply_id: id, user_id: user,
  create_time: time, update_time: time, content: { elements: [{ type: 'text_run', text_run: { text } }] } });
const comments = [{ comment_id: 'c', quote: 'anchor text', relation: { content_deleted: false }, replies: [
  reply('old', 'history', 'human', 1), reply('new', 'first'), reply('own', 'assistant reply', 'bot'),
] }];
const state = { seen: {} };
assert.equal(commentCandidates(binding, comments, state, { openId: 'bot' }).length, 1);
assert.ok(state.seen['c:old']);
assert.ok(state.seen['c:own']);
assert.throws(() => commentCandidates(binding, comments, state, {}), /identity/);
const payloads = [], accepted = new Set(), reactions = [];
let failAck = true;
const runtime = { config: { storageDir }, botIdentity: { openId: 'bot' },
  appClient: { drive: { v2: { commentReaction: { updateReaction: async payload => {
    assert.ok(accepted.size, 'reaction follows admission');
    reactions.push(payload);
    throw new Error('reaction unavailable');
  } } }, v1: {
    fileComment: { list: async () => ({ data: { items: comments } }) },
    fileCommentReply: { list: async () => ({ data: { items: comments[0].replies } }) },
  } } },
  requestRemoteLab: async (path, options) => {
    if (!options) return { response: { ok: true }, json: { session: { conversation: binding.conversation } } };
    payloads.push(structuredClone(options.body));
    accepted.add(options.body.requestId);
    if (failAck) { failAck = false; throw new Error('lost acknowledgement'); }
    return { response: { status: 202 }, json: { queued: true } };
  },
};
try {
  await writeBindingJson(join(bindingsDirectory(storageDir), `${bindingKey('doc')}.binding.json`), { ...binding, enabled: true });
  await assert.rejects(reconcileDocumentBinding(runtime, binding), /lost acknowledgement/);
  assert.equal(reactions.length, 0, 'uncertain admission must not acknowledge');
  // A concurrent comment arrives while the first admission has an uncertain receipt.
  comments[0].replies.push(reply('second', 'second'));
  await reconcileDocumentBinding(runtime, binding);
  assert.deepEqual(payloads[0], payloads[1], 'retry must use persisted exact payload');
  assert.equal(accepted.size, 2);
  assert.equal(reactions.length, 2, 'accepted comments acknowledged despite reaction failures');
  await reconcileDocumentBinding(runtime, binding);
  assert.equal(payloads.length, 3, 'unchanged comments must not repeat');
  comments[0].replies[1].content.elements[0].text_run.text = 'edited';
  comments[0].replies[1].update_time += 1;
  await reconcileDocumentBinding(runtime, binding);
  assert.equal(accepted.size, 3, 'edit is a distinct revision');
  const saved = await readBindingJson(join(bindingsDirectory(storageDir), `${bindingKey('doc')}.state.json`));
  assert.equal(saved.pending.length, 0);
  assert.equal(saved.lastError, '');
  let calls = 0;
  runtime.appClient.drive.v1.fileComment.list = async ({ params }) => {
    calls++;
    assert.equal(params.need_relation, true);
    return { data: params.page_token ? { items: comments } : { items: [], has_more: true, page_token: 'next' } };
  };
  assert.equal((await readDocumentComments(runtime, binding)).length, 1);
  assert.equal(calls, 2);
  runtime.appClient.drive.v1.fileComment.list = async () => ({ data: { items: [], has_more: true } });
  await assert.rejects(readDocumentComments(runtime, binding), /pagination/);
  runtime.requestRemoteLab = async () => ({ response: { ok: false }, json: {} });
  await assert.rejects(reconcileDocumentBinding(runtime, binding), /Session missing/);
  const head = { key: 'h', options: {}, runtimeSelection: {} };
  assert.equal(canForwardNativeRequest({ key: 'n', options: { sourceContext: { documentBinding: true } }, runtimeSelection: {} }, head), false);
  const template = normalizeScheduledSessionTemplate({ folder: '/tmp', tool: 'codex', reuse: 'calendar_day', reuseTimezone: 'Asia/Shanghai' });
  const key = time => scheduledSessionIdentity({ id: 'occurrence', scheduleId: 'schedule', scheduledAt: time }, template);
  assert.equal(key('2026-09-17T20:00:00Z'), key('2026-09-18T10:00:00Z'));
  assert.notEqual(key('2026-09-18T10:00:00Z'), key('2026-09-18T20:00:00Z'));
  assert.notEqual(key('2026-09-18T10:00:00Z'), scheduledSessionIdentity({ scheduleId: 'other', scheduledAt: '2026-09-18T10:00:00Z' }, template));
  console.log('document bindings: dedupe, revisions, self-filter, lost-ack recovery, pagination, target failure, queue and day keys passed');
} finally { await rm(storageDir, { recursive: true, force: true }); }
