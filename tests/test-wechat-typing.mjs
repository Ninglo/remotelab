// Run only through scripts/run-with-clean-instance-env.mjs (all transports below are mocks).
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createWeChatTypingApi, createWeChatTypingController } from '../connectors/wechat/typing.mjs';
import { handleWeChatMessage } from '../scripts/wechat-connector.mjs';
import { checkTyping } from '../scripts/wechat-typing-check.mjs';

const summary = { accountId: 'test-account', peerUserId: 'test-peer', messageId: 'test-message',
  messageTypeNumeric: 1, messageStateNumeric: 2, textPreview: 'test' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(2); }
  assert.fail('condition did not settle');
}
function fixture(overrides = {}) {
  const calls = [], reports = [];
  const controller = createWeChatTypingController({ delayMs: 1, keepaliveMs: 10,
    getConfig: async () => ({ typing_ticket: 'secret-ticket' }),
    sendTyping: async (_summary, _ticket, status) => { calls.push(status); },
    report: event => reports.push(event), ...overrides });
  return { controller, calls, reports };
}

// Fast tasks: no getconfig or late start.
{
  let configs = 0;
  const f = fixture({ getConfig: async () => { configs++; return { typing_ticket: 'secret' }; } });
  await f.controller.begin(summary).stop();
  await delay(15);
  assert.equal(configs, 0); assert.deepEqual(f.calls, []);
  await f.controller.close();
}
// A late config after completion does not emit typing.
{
  const gate = deferred(); let entered = false;
  const f = fixture({ getConfig: () => { entered = true; return gate.promise; } });
  const lease = f.controller.begin(summary);
  await until(() => entered);
  const stopping = lease.stop();
  assert.equal(lease.stop(), stopping);
  gate.resolve({ typing_ticket: 'secret-ticket' });
  await stopping;
  assert.deepEqual(f.calls, []);
  await f.controller.close();
}
// Overlapping target leases and long-running keepalive, then resource cleanup.
{
  const f = fixture();
  const a = f.controller.begin(summary), b = f.controller.begin(summary);
  await until(() => f.calls.length >= 3);
  await a.stop(); assert(!f.calls.includes(2));
  await b.stop(); assert.equal(f.calls.at(-1), 2);
  const count = f.calls.length;
  await delay(30); assert.equal(f.calls.length, count);
  await f.controller.close();
}
// In-flight start must settle before stop; new work during stop must restart after it.
{
  const start = deferred(), stop = deferred(); const calls = [];
  const f = fixture({ sendTyping: async (_s, _t, status) => {
    calls.push(status);
    if (calls.length === 1) await start.promise;
    if (status === 2 && calls.length === 2) await stop.promise;
  } });
  const a = f.controller.begin(summary);
  await until(() => calls.length === 1);
  const stopping = a.stop();
  assert.deepEqual(calls, [1]); start.resolve();
  await until(() => calls.length === 2);
  const b = f.controller.begin(summary);
  stop.resolve(); await stopping;
  await until(() => calls.length >= 3);
  assert.deepEqual(calls.slice(0, 3), [1, 2, 1]);
  await b.stop(); await f.controller.close();
}
// Ambiguous start errors still cancel; stop errors are bounded and sanitized.
{
  const f = fixture({ sendTyping: async () => { throw new Error('secret-ticket bearer secret-token'); } });
  const a = f.controller.begin(summary);
  await until(() => f.reports.some(r => r.operation === 'start'));
  await a.stop(); await f.controller.close();
  assert.equal(f.reports.filter(r => r.operation === 'stop').length, 2);
  assert(!JSON.stringify(f.reports).includes('secret'));
}
// Missing ticket and config failures are observable, without text fallback.
for (const getConfig of [async () => ({}), async () => { throw new Error('secret'); }]) {
  const f = fixture({ getConfig }); const a = f.controller.begin(summary);
  await until(() => f.reports.length > 0); await a.stop();
  assert.deepEqual(f.calls, []); await f.controller.close();
}
// Unsupported feedback does not poll repeatedly; a new message retries with fresh context.
{
  const seen = [];
  const f = fixture({ getConfig: async s => { seen.push(s.contextToken); return {}; } });
  const a = f.controller.begin({ ...summary, contextToken: 'old-context' });
  await until(() => seen.length === 1);
  await delay(40); assert.equal(seen.length, 1);
  const b = f.controller.begin({ ...summary, contextToken: 'fresh-context' });
  await until(() => seen.length === 2);
  assert.deepEqual(seen, ['old-context', 'fresh-context']);
  await a.stop(); await b.stop(); await f.controller.close();
}
// Shutdown drains independent targets and refuses later work.
{
  const f = fixture();
  f.controller.begin(summary); f.controller.begin({ ...summary, peerUserId: 'other' });
  await until(() => f.calls.length >= 2);
  await f.controller.close(); await f.controller.close();
  const count = f.calls.length;
  await f.controller.begin(summary).stop(); await delay(20);
  assert.equal(f.calls.length, count);
  assert.equal(f.calls.filter(s => s === 2).length, 2);
}
// Protocol shapes, timeout bound, HTTP-200 provider rejection and empty send response.
{
  const requests = []; let response = '{"typing_ticket":"secret-ticket","ret":0}';
  const api = createWeChatTypingApi({ post: async req => { requests.push(req); return response; },
    resolveAccount: () => ({ token: 'secret-token', baseUrl: 'https://invalid.example' }),
    baseInfo: () => ({ channel_version: 'test' }) });
  await api.getConfig({ ...summary, contextToken: 'secret-context' });
  assert.deepEqual(JSON.parse(requests[0].body), { ilink_user_id: 'test-peer',
    context_token: 'secret-context', base_info: { channel_version: 'test' } });
  assert.equal(requests[0].timeoutMs, 5000);
  response = ''; await api.sendTyping(summary, 'secret-ticket', 2);
  assert.deepEqual(JSON.parse(requests[1].body), { ilink_user_id: 'test-peer',
    typing_ticket: 'secret-ticket', status: 2, base_info: { channel_version: 'test' } });
  response = '{"ret":7,"errmsg":"secret"}';
  await assert.rejects(api.sendTyping(summary, 'secret-ticket', 1), /typing_provider_rejected/);
  await assert.rejects(api.getConfig(summary), /typing_provider_rejected/);
  response = '{"ret":0,"errcode":-14,"errmsg":"secret"}';
  await assert.rejects(api.sendTyping(summary, 'secret-ticket', 1), /typing_provider_rejected/);
}
// Real message handler: text/images, success/failure/cancellation/silent publication.
for (const kind of ['text', 'image', 'failure', 'cancelled', 'silent']) {
  const configGate = deferred(); let requested = false; const sent = [];
  const f = fixture({ getConfig: async () => { requested = true; return configGate.promise; } });
  const runtime = { config: {}, storagePaths: {}, processingMessageIds: new Set(), typingController: f.controller };
  await handleWeChatMessage(runtime, { ...summary,
    ...(kind === 'image' ? { textPreview: '', imageResources: [{}] } : {}) }, {
    wasMessageHandled: async () => false, markMessageHandled: async () => {},
    generateRemoteLabReply: async () => {
      await until(() => requested);
      if (kind === 'failure' || kind === 'cancelled') throw new Error(kind);
      return { requestId: 'test', replyText: kind === 'silent' ? '' : 'final' };
    },
    sendWeChatText: async (_runtime, _summary, text) => { sent.push(text); return { message_id: 'test-delivery' }; },
  });
  // Handler and final delivery settle even while getconfig is pending.
  assert.equal(runtime.processingMessageIds.size, 0);
  assert(sent.length <= 1);
  if (kind === 'text' || kind === 'image') assert.deepEqual(sent, ['final']);
  configGate.resolve({ typing_ticket: 'secret-ticket' });
  await f.controller.close(); assert.deepEqual(f.calls, []);
}
// Active typing is cancelled for every terminal path; a slow stop never holds final delivery.
for (const failure of [false, 'failed', 'cancelled']) {
  const stopGate = deferred(), calls = [], sent = [];
  const f = fixture({ sendTyping: async (_s, _t, status) => {
    calls.push(status); if (status === 2) await stopGate.promise;
  } });
  const runtime = { config: {}, storagePaths: {}, processingMessageIds: new Set(), typingController: f.controller };
  await handleWeChatMessage(runtime, { ...summary, textPreview: '', imageResources: [{}] }, {
    wasMessageHandled: async () => false, markMessageHandled: async () => {},
    generateRemoteLabReply: async () => {
      await until(() => calls.includes(1));
      if (failure) throw new Error(failure);
      return { requestId: 'active-test', replyText: 'final' };
    },
    sendWeChatText: async (_r, _s, text) => { sent.push(text); return { message_id: 'active-delivery' }; },
  });
  assert.equal(sent.length, 1);
  await until(() => calls.includes(2));
  stopGate.resolve(); await f.controller.close();
  assert.equal(calls.filter(s => s === 2).length, 1);
}
// Operator probe is bounded and never claims read receipts or exposes ticket values.
for (const mode of ['success', 'no-ticket', 'start-failed', 'stop-failed', 'config-failed']) {
  const calls = [];
  const result = await checkTyping({ summary, sleep: async ms => assert.equal(ms, 2000), api: {
    getConfig: async () => {
      if (mode === 'config-failed') throw new Error('secret-token');
      return mode === 'no-ticket' ? {} : { ret: 0, typing_ticket: 'secret-ticket' };
    },
    sendTyping: async (_s, _ticket, status) => {
      calls.push(status);
      if ((status === 1 && mode === 'start-failed') || (status === 2 && mode === 'stop-failed')) {
        throw new Error('secret-ticket');
      }
    },
  } });
  assert.equal(result.ok, mode === 'success');
  assert.equal(result.readReceipt, false);
  assert.equal(result.clientVisibilityVerified, false);
  assert(!JSON.stringify(result).includes('secret'));
  assert.deepEqual(calls, mode === 'config-failed' || mode === 'no-ticket' ? []
    : mode === 'stop-failed' ? [1, 2, 2] : [1, 2]);
}
console.log('WeChat native typing unit/scenario tests passed');
