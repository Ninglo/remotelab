#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createCodexDriver } from '../chat/native/codex.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const sent = [], events = [], settled = [], errors = [];
  const driver = createCodexDriver({ send: value => sent.push(value), onEvent: value => events.push(value), onSettled: value => settled.push(value), onError: error => errors.push(error), options, cwd: '/tmp' });
  const reply = (method, result, error) => {
    const request = sent.findLast(value => value.method === method);
    assert.ok(request, `expected ${method}`);
    driver.handle({ id: request.id, ...(error ? { error } : { result }) });
  };
  const notify = (method, params) => driver.handle({ method, params: { threadId: 'thread-1', ...params } });
  async function start() {
    const promise = driver.start('initial');
    await tick();
    reply('initialize', {}); await tick();
    assert.ok(sent.some(value => value.method === 'initialized' && value.id === undefined));
    const threadRequest = sent.findLast(value => value.method === 'thread/start' || value.method === 'thread/resume');
    assert.equal(threadRequest.params.approvalPolicy, 'never');
    assert.equal(threadRequest.params.sandbox, 'danger-full-access');
    reply(options.threadId || options.codexThreadId ? 'thread/resume' : 'thread/start', { thread: { id: 'thread-1' } }); await tick();
    reply('turn/start', { turn: { id: 'turn-1', status: 'inProgress' } });
    return promise;
  }
  return { driver, sent, events, settled, errors, reply, notify, start };
}

{
  const h = harness({ model: 'gpt-test', reasoningEffort: 'high', developerInstructions: 'Keep native rules.', disableApps: true });
  assert.deepEqual(h.driver.args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
  assert.ok(h.driver.args.includes('developer_instructions="Keep native rules."'));
  assert.ok(h.driver.args.includes('apps'));
  const started = await h.start();
  assert.equal(started.turnId, 'turn-1');
  const second = h.driver.submit({ id: 'input-2', text: 'change direction' }); await tick();
  const steer = h.sent.findLast(value => value.method === 'turn/steer');
  assert.equal(steer.params.expectedTurnId, 'turn-1');
  assert.equal(steer.params.clientUserMessageId, 'input-2');
  assert.equal(steer.params.input[0].text, 'change direction');
  assert.equal(h.settled.length, 0, 'steering must arrive while first turn is active');
  h.reply('turn/steer', { turnId: 'turn-1' });
  assert.equal((await second).mode, 'steer');
  h.notify('item/started', { item: { id: 'tool-1', type: 'commandExecution', command: 'pwd', status: 'inProgress' } });
  h.notify('item/completed', { item: { id: 'tool-1', type: 'commandExecution', command: 'pwd', status: 'completed', aggregatedOutput: '/tmp', exitCode: 0 } });
  h.notify('item/started', { item: { id: 'text-1', type: 'agentMessage', text: '' } });
  h.notify('item/agentMessage/delta', { itemId: 'text-1', delta: 'hello' });
  h.notify('item/completed', { item: { id: 'text-1', type: 'agentMessage', text: 'hello', phase: 'final_answer' } });
  h.notify('item/completed', { item: { id: 'reason-1', type: 'reasoning', summary: ['A', 'B'], content: ['hidden body'] } });
  h.notify('item/completed', { item: { id: 'file-1', type: 'fileChange', status: 'completed', changes: [{ path: 'a.js', kind: { type: 'update' }, diff: '-old\n+new' }] } });
  h.notify('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { total: { totalTokens: 90 }, last: { inputTokens: 30, outputTokens: 10, cachedInputTokens: 5, reasoningOutputTokens: 2, totalTokens: 40 }, modelContextWindow: 128000 } });
  h.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
  await tick();
  assert.equal(h.settled.length, 1);
  assert.equal(h.events.find(value => value.item?.type === 'command_execution' && value.type === 'item.completed').item.exit_code, 0);
  assert.equal(h.events.find(value => value.item?.id === 'text-1' && value.type === 'item.updated').item.text, 'hello');
  assert.equal(h.events.find(value => value.item?.type === 'reasoning').item.text, 'A\n\nB');
  assert.equal(h.events.find(value => value.item?.type === 'file_change').item.changes[0].kind, 'update');
  assert.equal(h.events.find(value => value.type === 'remotelab.context_metrics').contextTokens, 40);
  h.driver.close();
}
{
  const h = harness({ codexThreadId: 'thread-1' }); await h.start();
  const promise = h.driver.submit({ id: 'racing', text: 'next' }); await tick();
  h.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
  assert.equal(h.settled.length, 0, 'a submitted input must survive completion-before-ack');
  h.reply('turn/steer', null, { code: -32600, message: 'No active turn to steer' }); await tick();
  h.reply('turn/start', { turn: { id: 'turn-2', status: 'inProgress' } });
  assert.equal((await promise).turnId, 'turn-2');
  assert.equal(h.settled.length, 0);
  h.notify('turn/completed', { turn: { id: 'turn-2', status: 'completed', items: [] } }); await tick();
  assert.equal(h.settled.length, 1);
  h.driver.close();
}
{
  const h = harness(); await h.start();
  const promise = h.driver.submit({ id: 'no-replay', text: 'next' }); await tick();
  const rejection = assert.rejects(promise, /transport/);
  h.reply('turn/steer', null, { code: -32000, message: 'transport disconnected' });
  await rejection;
  assert.equal(h.sent.filter(value => value.method === 'turn/start').length, 1, 'ambiguous errors must not replay input');
  const invalid = h.driver.submit({ id: 'invalid', text: 'oversized' }); await tick();
  const invalidRejection = assert.rejects(invalid, error => error.code === 'NATIVE_REJECTED' && error.rpcCode === -32602);
  h.reply('turn/steer', null, { code: -32602, message: 'Input exceeds maximum length' });
  await invalidRejection;
  h.driver.handle({ id: 900, method: 'item/commandExecution/requestApproval', params: {} });
  assert.deepEqual(h.sent.find(value => value.id === 900)?.result, { decision: 'decline' });
  h.driver.handle({ id: 901, method: 'item/permissions/requestApproval', params: {} });
  assert.deepEqual(h.sent.find(value => value.id === 901)?.result.permissions, {});
  h.driver.handle({ id: 902, method: 'item/tool/requestUserInput', params: {} });
  assert.deepEqual(h.sent.find(value => value.id === 902)?.result, { answers: {} });
  h.driver.handle({ id: 903, method: 'execCommandApproval', params: {} });
  assert.equal(h.sent.find(value => value.id === 903)?.result.decision, 'abort', 'legacy approval must use a valid native denial');
  const waiting = h.driver.submit({ id: 'closing', text: 'next' }); await tick();
  const closed = assert.rejects(waiting, /closed/); h.driver.close(); await closed;
}
{
  const h = harness();
  const first = h.driver.start('initial'); await tick(); h.reply('initialize', {}); await tick(); h.reply('thread/start', { thread: { id: 'thread-1' } }); await tick();
  h.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
  h.reply('turn/start', { turn: { id: 'turn-1', status: 'inProgress' } }); await first; await tick();
  assert.equal(h.settled.length, 1, 'late start response must not reactivate a completed turn');
  h.driver.close();
}
{
  const h = harness();
  const starting = h.start();
  const queuedDuringHandshake = h.driver.submit({ id: 'early', text: 'early input' });
  await starting; await tick();
  assert.equal(h.sent.findLast(value => value.method === 'turn/steer').params.clientUserMessageId, 'early');
  h.reply('turn/steer', { turnId: 'turn-1' }); await queuedDuringHandshake;
  const interrupting = h.driver.interrupt(); await tick();
  h.reply('turn/interrupt', {}); await interrupting;
  h.notify('turn/completed', { threadId: 'child-thread', turn: { id: 'child-turn', status: 'completed' } });
  assert.equal(h.settled.length, 0, 'child thread completion must not finish the parent');
  h.notify('turn/completed', { turn: { id: 'turn-1', status: 'interrupted', items: [] } });
  assert.equal(h.settled[0].status, 'interrupted');
  h.driver.close();
}
console.log('test-native-codex: ok');
