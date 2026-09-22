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
    emit({ method: 'item/completed', params: { threadId: 'thread-jsonl', item: {
      id: 'command-jsonl', type: 'commandExecution', command: 'printf',
      aggregatedOutput: 'before\\u2028after\\u2029done', status: 'completed', exitCode: 0,
    } } });
    emit({ method: 'turn/completed', params: { threadId: 'thread-jsonl', turn: { id: 'turn-jsonl', status: 'completed' } } });
  }
});
`, 'utf8');
await chmod(command, 0o755);

try {
  const events = [];
  const result = await runNativeHost({
    directory: root,
    command,
    runtimeFamily: 'codex-json',
    options: {},
    prompt: 'test',
    cwd: root,
    env: { PATH: process.env.PATH },
    onProcess: async () => {},
    onStdout: async line => events.push(JSON.parse(line)),
    onStderr: async () => {},
  });
  assert.equal(result.code, 0);
  const commandEvent = events.find(event => event.item?.id === 'command-jsonl');
  assert.equal(commandEvent?.item?.aggregated_output, 'before\u2028after\u2029done');
  console.log('native host JSONL framing: U+2028 and U+2029 remain inside one protocol record');
} finally {
  await rm(root, { recursive: true, force: true });
}
