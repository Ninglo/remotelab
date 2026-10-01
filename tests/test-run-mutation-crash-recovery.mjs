import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-run-mutation-crash-'));
setIsolatedTestHome(home);
let writer;
try {
  const { createRun, updateRun, getRun, runDir } = await import('../chat/runs.mjs');
  const run = await createRun({ status: { sessionId: 'crash-session', state: 'running' },
    manifest: { sessionId: 'crash-session', options: {} } });
  const fixture = join(home, 'writer.mjs');
  await writeFile(fixture, `import { updateRun } from ${JSON.stringify(new URL('../chat/runs.mjs', import.meta.url).href)};
await updateRun(${JSON.stringify(run.id)}, current => {
  process.send({ locked: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  return { ...current, normalizedEventCount: 99 };
});`);
  writer = fork(fixture, [], { env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const [message] = await once(writer, 'message');
  assert.equal(message.locked, true, 'the writer entered a real Run mutation');
  const owner = JSON.parse(await readFile(join(runDir(run.id), '.mutation-lock/owner.json'), 'utf8'));
  assert.equal(owner.pid, writer.pid);
  const exited = once(writer, 'exit');
  writer.kill('SIGKILL');
  await exited;
  const recovered = await updateRun(run.id, { normalizedEventCount: 1 });
  assert.equal(recovered.normalizedEventCount, 1, 'a dead writer cannot block immediate recovery');
  assert.equal((await getRun(run.id)).normalizedEventCount, 1, 'the interrupted draft never replaced committed state');
  await assert.rejects(readFile(join(runDir(run.id), '.mutation-lock/owner.json')), { code: 'ENOENT' });
  console.log('test-run-mutation-crash-recovery: ok');
} finally {
  if (writer && writer.exitCode === null && !writer.signalCode) writer.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
}
