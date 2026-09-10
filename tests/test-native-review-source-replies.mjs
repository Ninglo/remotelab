import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'native-review-reply-'));
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const config = join(root, 'config');
const bin = join(root, 'bin');
await mkdir(config); await mkdir(bin);
await writeFile(join(config, 'tools.json'), JSON.stringify([{ id: 'fake-native', name: 'Fake native', command: 'fake-native',
  runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' }]));
await copyFile(join(repo, 'tests/fixtures/native-codex-app-server.cjs'), join(bin, 'fake-native'));
await chmod(join(bin, 'fake-native'), 0o755);
const child = fork(join(repo, 'tests/fixtures/native-codex-controller.mjs'), [], { cwd: repo,
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, SHELL: '/bin/sh', REMOTELAB_CONFIG_DIR: config,
    REMOTELAB_MEMORY_DIR: join(root, 'memory'), REMOTELAB_WORK_ROOT_DIR: root, REMOTELAB_MEMORY_WRITEBACK: 'off',
    REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
    REMOTELAB_USER_SHELL_ENV_B64: Buffer.from(JSON.stringify({ shell: '/bin/sh', mode: 'test', env: {} })).toString('base64') },
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
});
const pending = new Map();
let sequence = 0;
let errors = '';
child.stderr.on('data', value => { errors += value; });
child.on('message', message => {
  const operation = pending.get(message.id);
  if (!operation) return;
  pending.delete(message.id);
  message.error ? operation.reject(new Error(message.error)) : operation.resolve(message.value);
});
child.on('exit', () => { for (const operation of pending.values()) operation.reject(new Error(`Controller exited: ${errors}`)); pending.clear(); });
const rpc = (action, ...args) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, action, args });
});
const log = async () => (await readFile(join(root, 'native-log.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse);
const until = async predicate => {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${errors}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const options = (requestId, target) => ({ requestId, tool: 'fake-native',
  sourceDelivery: { connector: 'feishu', sourceRouteId: 'default', target: { chatId: 'chat', ...target } } });
try {
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(errors); })]);
  for (const [name, initialTarget, steeringTarget] of [
    ['assigned-thread', { messageId: 'root-message', replyInThread: true },
      { messageId: 'reply-message', rootId: 'root-message', threadId: 'assigned-thread' }],
    ['quoted-mainline', { chatType: 'group', messageId: 'first-quote', rootId: 'quoted-source-a' },
      { chatType: 'group', messageId: 'second-quote', rootId: 'quoted-source-b' }],
  ]) {
    const session = await rpc('create');
    const initial = await rpc('accept', session.id, 'Original task', [], options(`${name}-first`, initialTarget));
    await until(async () => (await log()).some(event => event.runId === initial.run.id && event.kind === 'turn/start'));
    await rpc('accept', session.id, 'Correction from the same conversation', [], options(`${name}-second`, steeringTarget));
    await until(async () => (await log()).some(event => event.runId === initial.run.id && event.kind === 'turn/steer'));
    await writeFile(join(root, `${initial.run.id}.release`), '');
    await until(async () => (await rpc('response', session.id, `${name}-second`))?.state === 'ready');
    const deliveries = [];
    for (;;) {
      const claim = await rpc('claim', { connector: 'feishu' });
      if (!claim) break;
      deliveries.push(claim.delivery);
      await rpc('complete', claim.delivery.id, claim.leaseId, { externalId: `reply-${name}-${deliveries.length}` });
    }
    assert.equal(deliveries.filter(item => item.text === 'durable native answer').length, 1,
      `${name}: root/thread aliases or mainline quotes must not publish duplicate final replies into one conversation`);
  }
  console.log('native source replies: Feishu thread aliases and main-timeline quotes retain one final publication');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
  for (const event of (await log()).filter(event => event.kind === 'process-start')) {
    try { process.kill(event.pid, 'SIGTERM'); } catch {}
  }
  await rm(root, { recursive: true, force: true });
}
