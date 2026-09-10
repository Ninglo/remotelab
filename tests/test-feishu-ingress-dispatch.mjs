import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
import { createConnectorInbox } from '../lib/connector-inbox.mjs';

const home = await mkdtemp(join(tmpdir(), 'feishu-ingress-dispatch-'));
setIsolatedTestHome(home);
const { handleMessage, buildFeishuInboxKey, initializeInbox } = await import('../scripts/feishu-connector.mjs');
const runtime = {
  config: { storageDir: home, sourceRouteId: 'bot', responsePolicy: { group: 'all' } },
  storagePaths: { messageIndexPath: join(home, 'message-index.json') },
  botIdentity: { openId: 'self' },
};
const base = { chatId: 'chat', chatType: 'group', messageType: 'text', tenantKey: 'tenant',
  messageText: 'task', sender: { senderType: 'user', openId: 'human' }, mentions: [] };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const withinDeadline = async (promise, label) => {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(label)), 750);
    })]);
  } finally { clearTimeout(timeout); }
};
let inbox;
const blocked = deferred();
try {
  const entered = deferred();
  const independent = deferred();
  const submitted = [];
  const helpers = {
    addProcessingReaction: async () => {},
    submitRemoteLabRequest: async (_runtime, summary) => {
      submitted.push(summary.messageId);
      if (summary.messageId === 'blocked') { entered.resolve(); await blocked.promise; }
      if (summary.messageId === 'independent') independent.resolve();
      return { sessionId: `session-${summary.threadId}` };
    },
  };
  const first = handleMessage(runtime, { ...base, messageId: 'blocked', threadId: 'a' }, 'test', helpers);
  await withinDeadline(entered.promise, 'first input did not enter transport');
  const second = handleMessage(runtime, { ...base, messageId: 'independent', threadId: 'b' }, 'test', helpers);
  try {
    await withinDeadline(independent.promise, 'independent topic was blocked by another topic transport');
  } finally { blocked.resolve(); await Promise.all([first, second]); }
  assert.deepEqual(submitted, ['blocked', 'independent']);

  assert.equal(buildFeishuInboxKey({ ...base, threadId: 'a' }), buildFeishuInboxKey({ ...base, topicId: 'a' }));
  assert.notEqual(buildFeishuInboxKey({ ...base, threadId: 'a' }), buildFeishuInboxKey({ ...base, threadId: 'b' }));
  assert.notEqual(buildFeishuInboxKey(base), buildFeishuInboxKey({ ...base, threadId: 'a' }));
  assert.notEqual(buildFeishuInboxKey(base), buildFeishuInboxKey({ ...base, tenantKey: 'other' }));
  const comment = { sourceKind: 'document_comment', fileType: 'docx', fileToken: 'file', commentId: 'a' };
  assert.notEqual(buildFeishuInboxKey(comment), buildFeishuInboxKey({ ...comment, commentId: 'b' }));

  const attempts = [];
  inbox = createConnectorInbox(join(home, 'inbox'), {
    conversationKey: entry => buildFeishuInboxKey(entry.summary),
    onError: () => {},
    process: async entry => {
      attempts.push(entry.id);
      if (entry.id === 'failed') throw new Error('main admission unavailable');
      return {};
    },
  });
  await inbox.accept('failed', { summary: { ...base, threadId: 'a' } });
  await inbox.accept('same-topic', { summary: { ...base, topicId: 'a' } });
  await inbox.accept('other-topic', { summary: { ...base, threadId: 'b' } });
  inbox.start();
  await inbox.idle();
  assert.deepEqual(attempts, ['failed', 'other-topic'], 'transport retries fence only their own conversation');
  const pending = await inbox.store.active();
  assert.deepEqual(pending.map(entry => entry.id), ['failed', 'same-topic']);
  inbox.stop(); await inbox.idle();

  const firstHttp = deferred();
  const releaseHttp = deferred();
  const nextHttp = deferred();
  const received = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/sessions') {
      response.end(JSON.stringify({ session: { id: body.externalTriggerId.split(':').at(-1) } }));
      return;
    }
    received.push(body.requestId);
    if (body.requestId === 'feishu:http-0') { firstHttp.resolve(); await releaseHttp.promise; }
    if (body.requestId === 'feishu:http-1') nextHttp.resolve();
    response.statusCode = 202;
    response.end(JSON.stringify({ response: { id: body.requestId }, run: { id: `run-${body.requestId}` } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const httpRoot = join(home, 'http');
  const httpRuntime = {
    config: { ...runtime.config, storageDir: httpRoot, sessionFolder: home, runtimeSelectionMode: 'pinned',
      sessionTool: 'codex', accessPolicy: { mode: 'all' }, chatBaseUrl: `http://127.0.0.1:${server.address().port}` },
    storagePaths: { eventsLogPath: join(httpRoot, 'events.jsonl'), knownSendersPath: join(httpRoot, 'senders.json'),
      messageIndexPath: join(httpRoot, 'index.json') },
    authCookie: 'isolated-test', botIdentity: runtime.botIdentity,
  };
  inbox = initializeInbox(httpRuntime);
  try {
    inbox.start();
    await inbox.accept('http-0', { summary: { ...base, messageId: 'http-0', threadId: 'http-0' }, sourceLabel: 'test' });
    await withinDeadline(firstHttp.promise, 'real Inbox did not submit its first event immediately');
    inbox.stop();
    await Promise.all(Array.from({ length: 8 }, (_, index) => inbox.accept(`http-${index + 1}`, {
      summary: { ...base, messageId: `http-${index + 1}`, threadId: `http-${index + 1}`,
        sender: { ...base.sender, openId: `sender-${index + 1}` } }, sourceLabel: 'test',
    })));
    inbox.start();
    await withinDeadline(nextHttp.promise, 'real Inbox held an independent topic behind a slow HTTP admission');
    releaseHttp.resolve();
    await inbox.idle();
    assert.equal(received.length, 9);
    assert.equal(new Set(received).size, 9);
    assert.equal((await inbox.store.active()).length, 0);
    const known = JSON.parse(await readFile(httpRuntime.storagePaths.knownSendersPath, 'utf8'));
    assert.equal(Object.keys(known.senders).length, 9, 'concurrent ingress preserves every sender index update');
    const index = JSON.parse(await readFile(httpRuntime.storagePaths.messageIndexPath, 'utf8'));
    assert.equal(Object.keys(index.records).length, 18, 'all inbound and thread bindings survive concurrent handoffs');
  } finally {
    releaseHttp.resolve();
    inbox.stop(); await inbox.idle();
    await new Promise(resolve => server.close(resolve));
  }
  console.log('Feishu ingress: independent topics bypass slow/failing transport; routing and retry scope remain stable');
} finally {
  blocked.resolve();
  inbox?.stop();
  await inbox?.idle();
  await rm(home, { recursive: true, force: true });
}
