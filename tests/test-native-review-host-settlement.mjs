import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runNativeHost } from '../chat/native-host.mjs';
import { submitNativeInput } from '../chat/native-input-transport.mjs';

const directory = await fs.mkdtemp(join(tmpdir(), 'native-review-settlement-'));
const command = join(directory, 'peer.cjs');
await fs.writeFile(command, `#!/usr/bin/env node
const lines = require('node:readline').createInterface({input: process.stdin});
const emit = message => console.log(JSON.stringify(message));
let turns = 0;
lines.on('line', line => {
  const {id, method} = JSON.parse(line);
  if (method === 'initialize') emit({id, result:{}});
  if (method === 'thread/start') emit({id, result:{thread:{id:'thread'}}});
  if (method === 'turn/start') {
    if (++turns === 1) emit({id,result:{turn:{id:'turn',status:'inProgress'}}});
    else emit({id,error:{code:-32602,message:'New input rejected'}});
  }
  if (method === 'review/complete') emit({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
});
lines.on('close', () => process.exit(0));
`, { mode: 0o755 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const ready = deferred();
const terminal = deferred();
let proc;
let intercepted = false;
const originalOpen = fs.open;
// Hold the durable transport claim across the native terminal event. This is
// the real ordering possible when fsync overlaps a model completion callback.
fs.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (!intercepted && args[0] === join(directory, 'native-inputs') && args[1] === 'r') {
    intercepted = true;
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      proc.stdin.write(JSON.stringify({ method: 'review/complete' }) + '\n');
      await terminal.promise;
      await sync();
    };
  }
  return handle;
};
syncBuiltinESMExports();
let completed = false;
const hosted = runNativeHost({ directory, command, runtimeFamily: 'codex-json', options: {}, prompt: 'first',
  cwd: directory, env: { PATH: process.env.PATH },
  onProcess: async child => { proc = child; },
  onStdout: async line => {
    const event = JSON.parse(line);
    if (event.type === 'turn.started') ready.resolve();
    if (event.type === 'turn.completed') terminal.resolve();
  },
  onStderr: async () => {},
}).then(result => { completed = true; return result; });
try {
  await ready.promise;
  await assert.rejects(submitNativeInput(directory, { id: 'late', text: 'rejected continuation' }), { code: 'NATIVE_REJECTED' });
  await Promise.race([hosted, new Promise(resolve => setTimeout(resolve, 250))]);
  assert.equal(completed, true, 'a rejected late input must not erase the already completed native turn');
  assert.equal((await hosted).code, 0);
  console.log('native host settlement: a late rejected input preserves the prior completed turn');
} finally {
  fs.open = originalOpen; syncBuiltinESMExports();
  terminal.resolve();
  proc?.kill('SIGKILL');
  await hosted;
  await fs.rm(directory, { recursive: true, force: true });
}
