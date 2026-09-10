import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeDriver } from '../chat/native/claude.mjs';
import { createClaudeAdapter } from '../chat/adapters/claude.mjs';

function harness(options = {}) {
  const sent = [], events = [], settled = [], errors = [];
  const driver = createClaudeDriver({ send: (m) => sent.push(m), onEvent: (m) => events.push(m),
    onSettled: (m) => settled.push(m), onError: (e) => errors.push(e), options });
  const queued = (input) => driver.handle({ type: 'command_lifecycle', command_uuid: input.uuid, state: 'queued' });
  const replay = (input) => driver.handle({ ...input, isReplay: true });
  const result = (input, extra = {}) => driver.handle({ type: 'result', subtype: 'success', is_error: false,
    user_message_uuid: input.uuid, user_message_uuids: [input.uuid], queued_turn_count: 0, ...extra });
  return { sent, events, settled, errors, driver, queued, replay, result };
}

test('Claude forwards input immediately and correlates results even with a zero native queue count', async () => {
  const h = harness({ claudeSessionId: 'prior', model: 'sonnet', effort: 'high' });
  assert.ok(h.driver.args.includes('--input-format'));
  assert.ok(h.driver.args.includes('--replay-user-messages'));
  assert.ok(h.driver.args.includes('--resume'));
  assert.equal(h.driver.args[h.driver.args.indexOf('--resume') + 1], 'prior');
  const first = h.driver.start('first');
  const firstInput = h.sent.at(-1);
  h.queued(firstInput);
  assert.equal((await first).accepted, true);
  const second = h.driver.submit({ id: 'second', text: 'change course' });
  const secondInput = h.sent.at(-1);
  assert.equal(secondInput.message.content, 'change course');
  h.queued(secondInput);
  assert.equal((await second).accepted, true);
  h.replay(firstInput);
  h.result(firstInput, { total_cost_usd: 0.01, usage: { input_tokens: 20, output_tokens: 5 } });
  assert.equal(h.settled.length, 0);
  assert.equal(h.events.at(-1).remotelabNativePending, true);
  assert.equal(h.events.at(-1).cost_usd, 0.01);
  const adapter = createClaudeAdapter();
  assert.ok(adapter.parseLine(JSON.stringify(h.events.at(-1))).some((e) => e.type === 'usage'));
  assert.ok(!adapter.parseLine(JSON.stringify(h.events.at(-1))).some((e) => e.type === 'status' && e.content === 'completed'));
  h.replay(secondInput);
  h.result(secondInput, { total_cost_usd: 0.03 });
  assert.equal(h.settled.length, 1);
  assert.ok(Math.abs(h.events.at(-1).cost_usd - 0.02) < 1e-10);
  h.result(secondInput);
  assert.equal(h.settled.length, 1);
  h.driver.close();
});

test('Claude retains the existing sandbox restriction on bypassing permissions', () => {
  const previous = process.env.IS_SANDBOX;
  try {
    delete process.env.IS_SANDBOX;
    const ordinary = harness({ dangerouslySkipPermissions: true });
    assert.ok(!ordinary.driver.args.includes('--dangerously-skip-permissions'));
    ordinary.driver.close();
    process.env.IS_SANDBOX = '1';
    const sandbox = harness({ dangerouslySkipPermissions: true });
    assert.ok(sandbox.driver.args.includes('--dangerously-skip-permissions'));
    sandbox.driver.close();
  } finally {
    if (previous === undefined) delete process.env.IS_SANDBOX;
    else process.env.IS_SANDBOX = previous;
  }
});

test('Claude supports consumption replay on older CLIs without inventing a write acknowledgement', async () => {
  const h = harness();
  let firstAccepted = false, secondAccepted = false;
  const first = h.driver.start('first').then(() => { firstAccepted = true; });
  const a = h.sent.at(-1);
  const second = h.driver.submit({ id: 'b', text: 'second' }).then(() => { secondAccepted = true; });
  const b = h.sent.at(-1);
  await Promise.resolve();
  assert.equal(firstAccepted, false);
  assert.equal(secondAccepted, false);
  h.replay(a);
  await first;
  h.driver.handle({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(h.settled.length, 0);
  assert.equal(secondAccepted, false);
  h.replay(b);
  await second;
  h.driver.handle({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(h.settled.length, 1);
  h.driver.close();
});

test('Claude handles native merged input turns and retains tool/thinking activity', async () => {
  const h = harness();
  const first = h.driver.start('first'); const a = h.sent.at(-1); h.queued(a);
  const second = h.driver.submit({ id: 'b', text: 'second' }); const b = h.sent.at(-1); h.queued(b);
  await Promise.all([first, second]);
  const activity = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'pwd' } }] } };
  h.driver.handle(activity);
  assert.equal(h.events.at(-1), activity);
  h.result(b, { user_message_uuids: [a.uuid, b.uuid] });
  assert.equal(h.settled.length, 1);
  h.driver.close();
});

test('Claude input identity, interrupt acknowledgement, and transport closure are explicit', async () => {
  const h = harness();
  const first = h.driver.submit({ id: 'same', text: 'first' });
  assert.equal(first, h.driver.submit({ id: 'same', text: 'first' }));
  await assert.rejects(h.driver.submit({ id: 'same', text: 'different' }), /different content/);
  const stop = h.driver.interrupt();
  const control = h.sent.at(-1);
  assert.equal(control.type, 'control_request');
  assert.deepEqual(control.request, { subtype: 'interrupt', cancel_queued: true });
  h.driver.handle({ type: 'control_response', response: { request_id: control.request_id, subtype: 'success', response: { still_queued: [] } } });
  await stop;
  h.driver.close(new Error('disconnected'));
  await assert.rejects(first, /disconnected/);
});

test('Claude startup failure rejects unaccepted input and reports a real error', async () => {
  const h = harness();
  const first = h.driver.start('first');
  h.driver.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['authentication unavailable'] });
  await assert.rejects(first, /authentication unavailable/);
  assert.equal(h.errors.length, 1);
  assert.equal(h.settled.length, 0);
  h.driver.close();
});

test('Claude complete thinking blocks do not repeat streamed thinking or lose a missing suffix', () => {
  let adapter = createClaudeAdapter();
  const parsed = [];
  const feed = (message) => parsed.push(...adapter.parseLine(JSON.stringify(message)));
  feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } });
  feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Think ' } } });
  feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'carefully' } } });
  const restored = createClaudeAdapter();
  restored.restoreProjectionState(adapter.getProjectionState());
  adapter = restored;
  feed({ type: 'assistant', message: { id: 'm', content: [{ type: 'thinking', thinking: 'Think carefully now' }] } });
  assert.equal(parsed.filter((e) => e.type === 'reasoning').map((e) => e.content).join(''), 'Think carefully now');
});
