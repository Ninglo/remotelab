#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeHost } from '../chat/native-host.mjs';

const root = await mkdtemp(join(tmpdir(), 'remotelab-native-jsonl-'));
const command = join(root, 'fake-codex.cjs');
await writeFile(command, `#!/usr/bin/env node
const lines = require('node:readline').createInterface({ input: process.stdin });
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') emit({ id: message.id, result: {} });
  if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-jsonl' } } });
  if (message.method === 'turn/start') {
    emit({ id: message.id, result: { turn: { id: 'turn-jsonl', status: 'inProgress' } } });
    emit({ method: 'item/started', params: { threadId: 'thread-jsonl', item: {
      id: 'command-jsonl', type: 'commandExecution', command: 'printf', status: 'inProgress',
    } } });
    const chunk = 'x'.repeat(2048);
    for (let index = 0; index < 512; index++) {
      emit({ method: 'item/commandExecution/outputDelta', params: {
        threadId: 'thread-jsonl', itemId: 'command-jsonl', delta: chunk,
      } });
    }
    emit({ method: 'item/completed', params: { threadId: 'thread-jsonl', item: {
      id: 'command-jsonl', type: 'commandExecution', command: 'printf',
      aggregatedOutput: chunk.repeat(512) + 'before\\u2028after\\u2029done', status: 'completed', exitCode: 0,
    } } });
    emit({ method: 'item/completed', params: { threadId: 'thread-jsonl', item: {
      id: 'answer-jsonl', type: 'agentMessage', text: 'finished after large output', phase: 'final_answer',
    } } });
    emit({ method: 'turn/completed', params: { threadId: 'thread-jsonl', turn: { id: 'turn-jsonl', status: 'completed' } } });
  }
});
`, 'utf8');
await chmod(command, 0o755);

try {
  const events = [];
  let releaseOutput;
  const outputBlocked = new Promise(resolve => { releaseOutput = resolve; });
  const result = await runNativeHost({
    directory: root,
    command,
    runtimeFamily: 'codex-json',
    options: {},
    prompt: 'test',
    cwd: root,
    env: { PATH: process.env.PATH },
    // exit may precede the last stdout data callback; close waits for all
    // streams, so the blocked writer sees one complete notification burst.
    onProcess: async proc => { proc.once('close', releaseOutput); },
    onStdout: async line => { await outputBlocked; events.push(JSON.parse(line)); },
    onStderr: async () => {},
  });
  assert.equal(result.code, 0);
  const commandEvent = events.find(event => event.type === 'item.completed' && event.item?.id === 'command-jsonl');
  assert.equal(commandEvent?.item?.aggregated_output, 'x'.repeat(2048 * 512) + 'before\u2028after\u2029done');
  const previews = events.filter(event => event.type === 'item.updated');
  assert.equal(previews.length, 1, 'a blocked writer coalesces 512 output notifications into one pending preview');
  assert.ok(previews[0].item.aggregated_output.length <= 4096);
  assert.equal(previews[0].item.output_bytes, 2048 * 512);
  assert.ok(events.indexOf(previews[0]) < events.indexOf(commandEvent), 'the completed item remains after its preview');
  const final = events.findIndex(event => event.item?.id === 'answer-jsonl');
  assert.ok(final > events.indexOf(commandEvent), 'the original final answer drains after tool completion');
  assert.equal(events.at(-1).type, 'turn.completed');
  console.log('native host JSONL framing and bounded command output: separators, backpressure, complete output and final answer passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
