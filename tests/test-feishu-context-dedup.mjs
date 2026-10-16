import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-context-dedup-'));
setIsolatedTestHome(home);
const { projectFeishuContext } = await import('../chat/feishu-context-dedup.mjs');
const { buildSourceContextPrompt } = await import('../chat/source-context-prompt.mjs');
const identity = { field: 'codexThreadId', id: 'thread-one' };
const entry = (messageId, text, extra = {}) => ({ messageId, text, sender: 'Alice', time: 'today',
  messageRevision: '100', senderType: 'user', edited: false, ...extra });
const source = messages => ({ connector: 'feishu', chatId: 'group', sourceRouteId: 'bot-one',
  messageId: 'current', messageRevision: '200', conversationContext: { messages } });
const prior = source([entry('background', 'new group discussion'), entry('samewords', 'same words')]);
prior.messageId = 'direct'; prior.messageRevision = '100';
const first = await projectFeishuContext('session', prior);
const raw = source([entry('direct', 'direct user message'), entry('background', 'new group discussion'),
  entry('own', 'native reply', { senderType: 'app' }), entry('other-bot', 'other bot reply', { senderType: 'app' }),
  entry('new', 'same words'), entry('unidentified', 'not accepted yet'), entry('edit', 'updated', { edited: true, senderType: 'app' })]);
const events = [
  { type: 'message', role: 'user', requestId: 'prior', sourceContext: prior },
  ...['own', 'edit'].map(externalId => ({ type: 'source_delivery', runId: 'prior-run', state: 'delivered', kind: 'content', providerMessageId: 'native-output', externalId })),
];
const deps = {
  head: async () => 50, history: async () => events,
  run: async id => ({ id, sessionId: 'session', codexThreadId: 'thread-one' }),
  manifest: async () => ({ feishuContextDelivery: first.receipt }),
  request: async () => ({ runId: 'prior-run', requestId: 'prior', options: {} }),
  accepted: async () => ({ state: 'accepted' }),
};
const project = (data = raw, overrides = {}, opts = {}) => projectFeishuContext('session', data, { identity, requestId: 'current', ...opts }, { ...deps, ...overrides });
const result = await project();
assert.deepEqual(result.sourceContext.conversationContext.messages.map(x => x.messageId), ['other-bot', 'new', 'unidentified', 'edit']);
assert.equal(result.receipt.stats.removed, 3);
assert.equal(raw.conversationContext.messages.length, 7, 'immutable accepted snapshot is retained');
assert.doesNotMatch(buildSourceContextPrompt(result.sourceContext), /native reply|new group discussion/);
assert.match(buildSourceContextPrompt(result.sourceContext), /other bot reply/);
assert.equal((await project(raw, {}, { identity: null })).sourceContext.conversationContext.messages.length, 7, 'fresh thread keeps background');
assert.equal((await project(raw, {}, { identity: { ...identity, id: 'different-thread' } })).receipt.stats.removed, 0);
assert.equal((await project(raw, { run: async () => ({ sessionId: 'other-session', codexThreadId: 'thread-one' }) })).receipt.stats.removed, 0);
assert.equal((await project(raw, { accepted: async () => null })).receipt.stats.removed, 1, 'queued/failed/uncertain input is not seen; own output is independently proven');
assert.equal((await project(raw, { accepted: async () => ({ state: 'dispatching' }) })).receipt.stats.removed, 1);
const edited = source([entry('background', 'CHANGED'), entry('direct', 'changed direct', { messageRevision: '101' })]);
assert.equal((await project(edited)).receipt.stats.removed, 0, 'body or revision edits are new');
assert.equal((await project({ ...raw, chatId: 'another-chat' })).receipt.stats.removed, 1, 'background knowledge is chat scoped');
assert.equal((await project({ ...raw, sourceRouteId: 'another-route' })).receipt.stats.removed, 1, 'background knowledge is connector scoped');
assert.equal((await project(raw, { history: async () => { throw new Error('fixture missing history'); } })).sourceContext, raw);
const samePacket = await project(source([entry('x', 'one'), entry('x', 'one'), entry('y', 'one')]), {}, { identity: null });
assert.equal(samePacket.receipt.stats.removed, 1, 'equal text with different IDs is not deduplicated');
const native = await project(raw, { request: async () => ({ nativeDispatchRunId: 'prior-run', requestId: 'prior', options: {}, nativeReceipt: { accepted: true }, nativeContextDelivery: first.receipt }) });
assert.equal(native.receipt.stats.removed, 3, 'accepted supplementary input shares evidence');
const linked = { ...source([]), linkedProjectContext: { sourceChatId: 'other-group', messages: [entry('linked', 'linked discussion')] } };
const linkedReceipt = (await projectFeishuContext('session', linked)).receipt;
assert.equal((await project(linked, { manifest: async () => ({ feishuContextDelivery: linkedReceipt }) })).receipt.stats.removed, 1);
assert.equal((await project({ ...linked, linkedProjectContext: { ...linked.linkedProjectContext, sourceChatId: 'third-group' } }, { manifest: async () => ({ feishuContextDelivery: linkedReceipt }) })).receipt.stats.removed, 0);
const distant = await project(raw, {
  history: async () => [...events, ...Array.from({length:45},(_,i)=>({type:'message',role:'user',requestId:'later-'+i,sourceContext:prior}))],
  request: async (_id,req) => req === 'prior' ? {runId:'prior-run',requestId:'prior',options:{}} : null,
});
assert.equal(distant.receipt.stats.removed,3,'complete replay retains delivery evidence older than 40 inputs');
const failedPublication = source([entry('own', 'Platform could not publish the native final.', { senderType: 'app' })]);
const failed = await project(failedPublication, {
  run: async id => ({ id, requestId: 'prior', sessionId: 'session', codexThreadId: 'thread-one' }),
  request: async () => ({ runId: 'prior-run', requestId: 'prior', options: {},
    responseDecisionErrors: { 'native-output': 'Input already has a different reply or handoff' } }),
});
assert.equal(failed.sourceContext.conversationContext.messages.length, 1,
  'legacy replacement error notices are not knowledge of the rejected native final');
assert.match(buildSourceContextPrompt(failed.sourceContext), /Platform could not publish/);
console.log('Feishu context dedup: same thread, fresh thread, scoped IDs, edited messages, unknown receipt, native supplement, linked group, immutable snapshot and fail-open passed');
await rm(home, { recursive: true, force: true });
