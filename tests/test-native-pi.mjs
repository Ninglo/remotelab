import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPiDriver } from '../chat/native/pi.mjs';

function harness(options = {}) {
  const sent = [], events = [], settled = [], errors = [];
  const driver = createPiDriver({
    send: (message) => sent.push(message),
    onEvent: (event) => events.push(event),
    onSettled: (result) => settled.push(result),
    onError: (error) => errors.push(error), options,
  });
  const respond = (command, data = {}, success = true) => driver.handle({
    type: 'response', id: command.id, command: command.type, success,
    ...(success ? { data } : { error: 'rejected during preflight' }),
  });
  const state = (data = {}) => respond(sent.findLast((item) => item.type === 'get_state'), {
    isStreaming: false, isCompacting: false, pendingMessageCount: 0, ...data,
  });
  return { driver, sent, events, settled, errors, respond, state };
}

test('Pi sends native steering before current tools finish and waits for provider drain', async () => {
  const h = harness({ model: 'openai-codex/gpt-6', effort: 'high', piSessionId: 'native-session' });
  assert.deepEqual(h.driver.args.slice(0, 5), ['--mode', 'rpc', '--provider', 'openai-codex', '--approve']);
  assert.ok(h.driver.args.includes('--session-id'));
  assert.equal(h.driver.args[h.driver.args.indexOf('--model') + 1], 'gpt-6');
  assert.equal(h.driver.args[h.driver.args.indexOf('--thinking') + 1], 'high');
  const start = h.driver.start('first');
  h.respond(h.sent[0]);
  h.driver.handle({ type: 'agent_start' });
  h.state({ isStreaming: true });
  await start;
  h.driver.handle({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'sleep 3' } });
  const second = h.driver.submit({ id: 'message-2', text: 'change course' });
  const command = h.sent.at(-1);
  assert.equal(command.type, 'prompt');
  assert.equal(command.streamingBehavior, 'steer');
  assert.equal(command.message, 'change course');
  h.respond(command);
  assert.equal((await second).accepted, true);
  h.state({ isStreaming: true, pendingMessageCount: 1 });
  h.driver.handle({ type: 'agent_end', willRetry: false });
  assert.equal(h.settled.length, 0);
  h.driver.handle({ type: 'agent_settled' });
  h.state({ pendingMessageCount: 1 });
  assert.equal(h.settled.length, 0);
  assert.equal(h.events.filter((e) => e.type === 'agent_settled').length, 0);
  h.driver.handle({ type: 'queue_update', steering: [], followUp: [] });
  h.driver.handle({ type: 'agent_settled' });
  h.state();
  assert.equal(h.settled.length, 1);
  assert.equal(h.events.filter((e) => e.type === 'agent_settled').length, 1);
  h.driver.handle({ type: 'agent_settled' });
  h.state();
  assert.equal(h.settled.length, 1);
  h.driver.close();
});

test('Pi uses the selected provider and native model id without losing resume options', () => {
  const h = harness({ model: 'anthropic/claude-sonnet-4-6', piSessionId: 'existing', effort: 'medium' });
  assert.equal(h.driver.args[h.driver.args.indexOf('--provider') + 1], 'anthropic');
  assert.equal(h.driver.args[h.driver.args.indexOf('--model') + 1], 'claude-sonnet-4-6');
  assert.equal(h.driver.args[h.driver.args.indexOf('--session-id') + 1], 'existing');
  h.driver.close();
});

test('Pi does not finalize a submit racing a previous idle response or unsettled retry', async () => {
  const h = harness();
  const first = h.driver.start('first');
  h.respond(h.sent[0]);
  const staleProbe = h.sent.at(-1);
  h.driver.handle({ type: 'agent_start' });
  await first;
  h.driver.handle({ type: 'agent_end', willRetry: true });
  h.respond(staleProbe, { isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  assert.equal(h.settled.length, 0);
  const next = h.driver.submit({ id: 'later', text: 'also this' });
  const command = h.sent.at(-1);
  h.driver.handle({ type: 'agent_settled' });
  h.state();
  assert.equal(h.settled.length, 0);
  h.respond(command);
  await next;
  h.driver.handle({ type: 'agent_start' });
  h.state({ isStreaming: true });
  assert.equal(h.settled.length, 0);
  h.driver.close();
});

test('Pi rejects preflight errors, deduplicates input ids and closes awaiting requests', async () => {
  const h = harness();
  const first = h.driver.submit({ id: 'same', text: 'first' });
  const duplicate = h.driver.submit({ id: 'same', text: 'first' });
  assert.equal(first, duplicate);
  assert.equal(h.sent.length, 1);
  h.respond(h.sent[0], {}, false);
  await assert.rejects(first, /preflight/);
  await assert.rejects(h.driver.submit({ id: 'same', text: 'changed' }), /different content/);
  const pending = h.driver.submit({ id: 'other', text: 'pending' });
  h.driver.close(new Error('transport disconnected'));
  await assert.rejects(pending, /transport disconnected/);
  await assert.rejects(h.driver.submit({ id: 'closed', text: 'ignored' }), /transport disconnected/);
});

test('Pi interrupt clears native queue before aborting', async () => {
  const h = harness();
  const stopped = h.driver.interrupt();
  assert.equal(h.sent[0].type, 'clear_queue');
  h.respond(h.sent[0], { steering: ['pending'], followUp: [] });
  await Promise.resolve();
  assert.equal(h.sent.at(-1).type, 'abort');
  h.respond(h.sent.at(-1));
  await stopped;
  h.driver.close();
});

test('Pi rejected input racing settlement does not strand the active run', async () => {
  const h = harness();
  const first = h.driver.start('first'); h.respond(h.sent[0]);
  h.driver.handle({ type: 'agent_start' }); h.state({ isStreaming: true }); await first;
  const second = h.driver.submit({ id: 'bad', text: 'bad' }); const command = h.sent.at(-1);
  h.driver.handle({ type: 'agent_settled' }); h.state();
  h.respond(command, {}, false); await assert.rejects(second, /preflight/);
  h.state();
  assert.equal(h.settled.length, 1);
  h.driver.close();
});

test('Pi reports final provider failure only after the native retry loop settles', async () => {
  const h = harness();
  const first = h.driver.start('first'); h.respond(h.sent[0]);
  h.driver.handle({ type: 'agent_start' }); h.state({ isStreaming: true }); await first;
  h.driver.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider unavailable' } });
  h.driver.handle({ type: 'agent_end', willRetry: true });
  assert.equal(h.settled.length, 0);
  h.driver.handle({ type: 'agent_settled' }); h.state();
  assert.equal(h.settled[0].status, 'failed');
  assert.match(h.settled[0].error, /provider unavailable/);
  h.driver.close();
});

test('Pi successful native retry clears the earlier provider error', async () => {
  const h = harness();
  const first = h.driver.start('first'); h.respond(h.sent[0]);
  h.driver.handle({ type: 'agent_start' }); h.state({ isStreaming: true }); await first;
  h.driver.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'temporary failure' } });
  h.driver.handle({ type: 'agent_end', willRetry: true });
  h.driver.handle({ type: 'agent_start' });
  h.driver.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered' }] } });
  h.driver.handle({ type: 'agent_settled' }); h.state();
  assert.equal(h.settled[0].status, 'completed');
  assert.equal(h.settled[0].error, undefined);
  h.driver.close();
});
