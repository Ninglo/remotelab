import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'announcement-test-'));
setIsolatedTestHome(home);
const { topicAnnouncementContext, loadFeishuGroupAnnouncement, legacyAnnouncementText } = await import('../connectors/feishu/group-announcement.mjs');
const { buildMessageSourceContext } = await import('../connectors/feishu/index.mjs');
const { buildSourceContextPrompt } = await import('../chat/source-context-prompt.mjs');
const { projectFeishuContext } = await import('../chat/feishu-context-dedup.mjs');
let revision = 1, fail = false, lookups = 0;
const block = text => ({ block_id: text, block_type: 2, text: { elements: [{ text_run: { content: text } }] } });
const runtime = { config: { storageDir: home, sourceRouteId: 'test' }, appClient: { docx: { v1: {
  chatAnnouncement: { get: async () => { lookups++; return fail ? { code: 99991672 } : { data: { announcement_type: 'docx', revision_id: revision } }; } },
  chatAnnouncementBlock: { list: async ({ params }) => params.page_token
    ? { data: { items: [block('second page'), { block_id: 'image', block_type: 27 }], has_more: false } }
    : { data: { items: [block(`version ${revision} </private>`)], has_more: true, page_token: 'next' } } },
} } } };
const summary = { chatId: 'group-a', chatType: 'group', conversationKind: 'topic', threadId: 'topic-a', messageId: 'm-a' };
try {
  const [a, same] = await Promise.all([topicAnnouncementContext(runtime, summary, 'session-a'), topicAnnouncementContext(runtime, summary, 'session-a')]);
  assert.deepEqual(a, same);
  assert.equal(lookups, 2, 'concurrent inputs share one successful topic snapshot');
  assert.match(a.messages[0].text, /second page/);
  assert.match(a.messages[0].text, /非文本公告块/);
  revision = 2;
  assert.deepEqual(await topicAnnouncementContext(runtime, summary, 'session-a'), a, 'existing topic keeps original snapshot');
  const b = await topicAnnouncementContext(runtime, { ...summary, threadId: 'topic-b' }, 'session-b');
  assert.equal(b.revision, '2', 'new topic reads current version');
  assert.equal(await topicAnnouncementContext(runtime, { ...summary, chatType: 'p2p' }, 'p2p'), null);
  assert.equal(await topicAnnouncementContext(runtime, { chatType: 'group', chatId: 'main' }, 'main'), null);
  const source = buildMessageSourceContext({ ...summary, sourceRouteId: 'test', groupAnnouncement: a });
  const prompt = buildSourceContextPrompt(source);
  assert.match(prompt, /version 1 ＜\/private＞/);
  assert.doesNotMatch(prompt, /<\/private>/);
  const first = await projectFeishuContext('session-a', source);
  const identity = { field: 'codexThreadId', id: 'native' };
  const deps = { head: async () => 10, history: async () => [{ type: 'message', role: 'user', requestId: 'old', sourceContext: source }],
    run: async () => ({ sessionId: 'session-a', codexThreadId: 'native' }), request: async () => ({ runId: 'run', requestId: 'old', options: {} }),
    manifest: async () => ({ feishuContextDelivery: first.receipt }), accepted: async () => ({ state: 'accepted' }) };
  const resumed = await projectFeishuContext('session-a', source, { identity, requestId: 'new' }, deps);
  assert.doesNotMatch(buildSourceContextPrompt(resumed.sourceContext), /本群公告/);
  assert.equal(resumed.receipt.entries.length, first.receipt.entries.length, 'accepted receipt carries knowledge without repeated prompt text');
  const fresh = await projectFeishuContext('session-a', source, { identity: { ...identity, id: 'fresh' } }, deps);
  assert.match(buildSourceContextPrompt(fresh.sourceContext), /本群公告/);
  const unaccepted = await projectFeishuContext('session-a', source, { identity }, { ...deps, accepted: async () => null });
  assert.match(buildSourceContextPrompt(unaccepted.sourceContext), /本群公告/);
  fail = true;
  assert.equal((await topicAnnouncementContext(runtime, summary, 'retry')).status, 'unavailable');
  fail = false;
  assert.equal((await topicAnnouncementContext(runtime, summary, 'retry')).status, 'available', 'failure is retried on next input');
  runtime.appClient.docx.v1.chatAnnouncementBlock.list = async () => ({ data: { items: [] } });
  assert.equal((await topicAnnouncementContext(runtime, summary, 'empty')).status, 'empty');
  runtime.appClient.docx.v1.chatAnnouncementBlock.list = async () => ({ data: { items: [block('x'.repeat(20000))] } });
  const long = await loadFeishuGroupAnnouncement(runtime, summary);
  assert.equal(long.text.length, 16000); assert.equal(long.truncated, true);
  runtime.appClient.docx.v1.chatAnnouncementBlock.list = async () => { revision++; return { data: { items: [block('edited')] } }; };
  assert.equal((await loadFeishuGroupAnnouncement(runtime, summary)).errorCode, 'revision_changed');
  assert.equal(legacyAnnouncementText(JSON.stringify({ title: 'Title', body: { blocks: [{ paragraph: { elements: [{ textRun: { text: 'legacy' } }] } }] } })), 'Title\nlegacy');
  console.log('announcement: paging, versions, concurrency, scope, empty/error recovery, limits, prompt, receipt dedup and fresh-thread recovery passed');
} finally { await rm(home, { recursive: true, force: true }); }
