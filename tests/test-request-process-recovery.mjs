import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'remotelab-process-recovery-'));
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const config = join(root, 'config');
const bin = join(root, 'bin');
await mkdir(config); await mkdir(bin);
await writeFile(join(config, 'tools.json'), JSON.stringify([{ id: 'fake-restart', name: 'Fake', command: 'fake-restart', runtimeFamily: 'codex-json' }]));
await writeFile(join(bin, 'fake-restart'), `#!/usr/bin/env node
const fs = require('fs');
const run = process.env.REMOTELAB_RUN_ID;
if (!run) { console.log('{}'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(join(root, 'starts'))}, run + '\\n');
console.log(JSON.stringify({type:'thread.started', thread_id:'restart-thread'}));
console.log(JSON.stringify({type:'turn.started'}));
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(join(root, 'release'))})) return;
  clearInterval(timer);
  console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'durable answer'}}));
  console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:1,output_tokens:1}}));
}, 20);
`, { mode: 0o755 });

let child;
let nextId = 0;
const pending = new Map();
const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, SHELL: '/bin/sh',
  REMOTELAB_CONFIG_DIR: config, REMOTELAB_MEMORY_DIR: join(root, 'memory'),
  REMOTELAB_WORK_ROOT_DIR: root, REMOTELAB_MEMORY_WRITEBACK: 'off',
  REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
  REMOTELAB_USER_SHELL_ENV_B64: Buffer.from(JSON.stringify({ shell: '/bin/sh', mode: 'test', env: {} })).toString('base64') };
async function boot() {
  child = fork(join(repo, 'tests/fixtures/request-controller.mjs'), [], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  child.on('message', message => { if (message.id) { const pair = pending.get(message.id); pending.delete(message.id); if (pair) message.error ? pair.reject(new Error(message.error)) : pair.resolve(message.value); } });
  child.on('exit', (code, signal) => { for (const pair of pending.values()) pair.reject(new Error(`Controller exited ${code ?? signal}: ${errors}`)); pending.clear(); });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(errors); })]);
}
function rpc(action, ...args) {
  const id = ++nextId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, action, args }); });
}
async function kill() {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function until(predicate, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`Timeout: ${description}`);
}
try {
  await boot();
  const session = await rpc('create');
  const options = { requestId: 'upstream-event', tool: 'fake-restart', sourceDelivery: { connector: 'feishu', sourceRouteId: 'default', target: { chatId: 'chat' } } };
  const accepted = await rpc('accept', session.id, 'work', [], options);
  assert.ok(accepted.run.id);
  await kill(); // Admission has returned; no assumptions about how far preparation got.
  await boot();
  await until(async () => (await readFile(join(root, 'starts'), 'utf8').catch(() => '')).includes(accepted.run.id), 'detached executor started');
  const duplicate = await rpc('accept', session.id, 'work', [], options);
  assert.equal(duplicate.run.id, accepted.run.id);
  assert.equal(duplicate.duplicate, true);
  await kill(); // Executor must survive loss of its observer.
  await writeFile(join(root, 'release'), '');
  await until(async () => !!(await readFile(join(config, 'chat-runs', accepted.run.id, 'result.json'), 'utf8').catch(() => '')), 'executor finishes while control plane is absent');
  await boot();
  await until(async () => (await rpc('response', session.id, 'upstream-event'))?.state === 'ready', 'restart settles result');
  const response = await rpc('response', session.id, 'upstream-event');
  assert.equal(response.payload.text, 'durable answer');
  const starts = (await readFile(join(root, 'starts'), 'utf8')).trim().split('\n');
  assert.equal(starts.filter(x => x === accepted.run.id).length, 1, 'recovery must not execute AI twice');
  const claim = await rpc('claim', { connector: 'feishu' });
  assert.equal(claim.delivery.text, 'durable answer');
  await rpc('complete', claim.delivery.id, claim.leaseId, { externalId: 'confirmed-feishu-message' });
  await kill();
  await boot();
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'delivered reply must not reappear after restart');
  console.log('process recovery: SIGKILL after admission and during execution, offline completion, exactly one attempt and persistent delivery receipt passed');
} finally {
  if (child?.exitCode === null) await kill();
  await writeFile(join(root, 'release'), '').catch(() => {});
  await rm(root, { recursive: true, force: true });
}
