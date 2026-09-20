import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAntigravityDriver } from '../chat/native/antigravity.mjs';
import { runNativeHost } from '../chat/native-host.mjs';

function harness(options = {}) {
  const sent = [];
  const events = [];
  const settled = [];
  const errors = [];
  const driver = createAntigravityDriver({
    send: (message) => sent.push(message),
    onEvent: (message) => events.push(message),
    onSettled: (result) => settled.push(result),
    onError: (error) => errors.push(error),
    options,
  });
  const accept = (stepIndex) => driver.handle({
    event: 'step_update',
    step_update: { conversation_id: 'new-conversation', step_index: stepIndex, state: 'DONE', step_type: 'user_input' },
  });
  const result = (status = 'SUCCESS', extra = {}) => driver.handle({
    event: 'result',
    result: { conversation_id: 'new-conversation', status, response: 'ok', ...extra },
  });
  return { sent, events, settled, errors, driver, accept, result };
}

test('Antigravity native driver resumes a conversation and settles after every queued input drains', async () => {
  const h = harness({ antigravityConversationId: 'prior-conversation', model: 'gemini-test', effort: 'high' });
  assert.ok(h.driver.args.includes('--input-format'));
  assert.equal(h.driver.args[h.driver.args.indexOf('--conversation') + 1], 'prior-conversation');
  assert.equal(h.driver.args[h.driver.args.indexOf('--model') + 1], 'gemini-test');

  const first = h.driver.start('first');
  const second = h.driver.submit({ id: 'second', text: 'second' });
  assert.deepEqual(h.sent.map((message) => message.message.content), ['first', 'second']);
  h.driver.handle({ event: 'init', conversation_id: 'new-conversation', init: {} });
  h.accept(0);
  const firstReceipt = await first;
  assert.equal(firstReceipt.accepted, true);
  assert.equal(firstReceipt.protocol, 'antigravity-stream-json');
  assert.equal(firstReceipt.conversationId, 'new-conversation');
  h.result();
  assert.equal(h.settled.length, 0, 'the first result must not drop a queued second input');
  h.accept(1);
  assert.equal((await second).accepted, true);
  h.result();
  assert.deepEqual(h.settled, [{ status: 'completed', conversationId: 'new-conversation' }]);
  h.driver.close();
});

test('Antigravity native driver keeps idempotent input receipts and exposes terminal errors', async () => {
  const h = harness();
  const first = h.driver.submit({ id: 'same', text: 'hello' });
  assert.equal(first, h.driver.submit({ id: 'same', text: 'hello' }));
  await assert.rejects(h.driver.submit({ id: 'same', text: 'different' }), /different content/);
  h.accept(0);
  await first;
  h.result('ERROR', { error: 'authentication required' });
  assert.deepEqual(h.settled, [{ status: 'failed', error: 'authentication required', conversationId: 'new-conversation' }]);
  h.driver.close();
});

test('Antigravity native host drives the official stream shape through a detached process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remotelab-native-antigravity-'));
  const executable = join(root, 'fake-agy');
  const directory = join(root, 'run');
  await writeFile(executable, `#!/usr/bin/env node
const readline = require('node:readline');
const conversationId = 'conversation-from-cli';
console.log(JSON.stringify({event:'init', conversation_id:conversationId, init:{permission_mode:'request-review'}}));
let step = 0;
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const input = JSON.parse(line);
  console.log(JSON.stringify({event:'step_update', step_update:{conversation_id:conversationId, step_index:step++, state:'DONE', step_type:'user_input'}}));
  console.log(JSON.stringify({event:'step_update', step_update:{conversation_id:conversationId, step_index:step++, state:'DONE', step_type:'agent_response', text_delta:'fixture reply'}}));
  console.log(JSON.stringify({event:'result', result:{conversation_id:conversationId, status:'SUCCESS', response:'fixture reply', num_turns:1}}));
});
`);
  await chmod(executable, 0o700);
  const events = [];
  const stderr = [];
  try {
    const result = await runNativeHost({
      directory,
      command: executable,
      runtimeFamily: 'antigravity-stream-json',
      options: {},
      prompt: 'hello',
      cwd: root,
      env: process.env,
      onStdout: (line) => events.push(JSON.parse(line)),
      onStderr: (line) => stderr.push(line),
      onProcess: async () => {},
    });
    assert.equal(result.code, 0, `${result.error?.message || ''}\n${stderr.join('\n')}`);
    assert.equal(events[0]?.event, 'init');
    assert.equal(events.find((event) => event.event === 'result')?.result?.response, 'fixture reply');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
