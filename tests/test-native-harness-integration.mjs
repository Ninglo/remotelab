#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'remotelab-native-integration-'));
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const config = join(root, 'config'), bin = join(root, 'bin');
const validationLog = join(tmpdir(), `remotelab-native-integration-results-${process.pid}.log`);
const evidence = async message => { console.log(message); await appendFile(validationLog, `${new Date().toISOString()} ${message}\n`); };
await mkdir(config); await mkdir(bin);
await writeFile(join(config, 'tools.json'), JSON.stringify([
  { id: 'fake-native', name: 'Fake native', command: 'fake-native', runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' },
  { id: 'fake-switch', name: 'Other runtime', command: 'fake-native', runtimeFamily: 'codex-json', inputMode: 'batch', promptMode: 'bare-user' },
]));
await copyFile(join(repo, 'tests/fixtures/native-codex-app-server.cjs'), join(bin, 'fake-native'));
await chmod(join(bin, 'fake-native'), 0o755);
const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, SHELL: '/bin/sh',
  REMOTELAB_CONFIG_DIR: config, REMOTELAB_MEMORY_DIR: join(root, 'memory'), REMOTELAB_WORK_ROOT_DIR: root,
  REMOTELAB_MEMORY_WRITEBACK: 'off', REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
  REMOTELAB_USER_SHELL_ENV_B64: Buffer.from(JSON.stringify({ shell: '/bin/sh', mode: 'test', env: {} })).toString('base64') };
let child, nextId = 0, succeeded = false;
const pending = new Map();
let controllerErrors = '';
async function boot() {
  child = fork(join(repo, 'tests/fixtures/native-codex-controller.mjs'), [], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { controllerErrors += chunk; });
  child.on('message', message => { if (message.id) { const pair = pending.get(message.id); pending.delete(message.id); if (pair) message.error ? pair.reject(Object.assign(new Error(message.error), { code: message.errorCode })) : pair.resolve(message.value); } });
  child.on('exit', (code, signal) => { for (const pair of pending.values()) pair.reject(new Error(`Controller exited ${code ?? signal}: ${controllerErrors}`)); pending.clear(); });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(controllerErrors); })]);
}
function rpc(action, ...args) {
  const id = ++nextId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, action, args }); });
}
async function killController() {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function logs() { return (await readFile(join(root, 'native-log.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
async function until(predicate, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timeout: ${description}\n${controllerErrors}\n${JSON.stringify(await logs())}`);
}
const receipt = (runId, requestId) => readFile(join(config, 'chat-runs', runId, 'native-inputs', `${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}.json`), 'utf8').then(JSON.parse).catch(() => null);
const options = requestId => ({ requestId, tool: 'fake-native', promptMode: 'bare-user', sourceDelivery: { connector: 'feishu', sourceRouteId: 'default', target: { chatId: 'same-chat' } } });
async function accept(sessionId, requestId, text) { return rpc('accept', sessionId, text, [], options(requestId)); }
async function awaitAnswer(sessionId, requestId) {
  await until(async () => (await rpc('response', sessionId, requestId))?.state === 'ready', `${requestId} gets final response`);
  const result = await rpc('response', sessionId, requestId);
  assert.equal(result.payload.text, 'durable native answer');
  return result;
}
try {
  await boot();
  const session = await rpc('create');
  const first = await accept(session.id, 'first', 'Start held native work');
  await until(async () => (await logs()).some(event => event.runId === first.run.id && event.kind === 'turn/start'), 'first native turn started');
  await assert.rejects(rpc('accept', session.id, 'Switch the active runtime', [], { ...options('blocked-switch'), tool: 'fake-switch' }), error => error.code === 'SESSION_BUSY');
  const second = await accept(session.id, 'second', 'Use my correction immediately');
  assert.equal(second.queued, false, 'native input admission is not reported as a controller-managed task queue');
  await until(async () => (await receipt(first.run.id, 'second'))?.state === 'accepted', 'second input acknowledged durably before completion');
  assert.equal((await logs()).filter(event => event.kind === 'completed').length, 0);
  assert.equal((await logs()).filter(event => event.kind === 'process-start').length, 1);
  await evidence('PASS: second user message reached native turn/steer before the active turn completed, in one detached Harness process.');
  await killController(); await boot();
  const duplicate = await accept(session.id, 'second', 'Use my correction immediately');
  assert.equal(duplicate.duplicate, true);
  await accept(session.id, 'third', 'Another correction after controller recovery');
  await until(async () => (await receipt(first.run.id, 'third'))?.state === 'accepted', 'third input steered after recovery');
  assert.equal((await logs()).filter(event => event.kind === 'turn/steer' && event.clientId === 'second').length, 1);
  assert.equal((await logs()).filter(event => event.kind === 'process-start').length, 1);
  await killController();
  await writeFile(join(root, `${first.run.id}.release`), '');
  await until(async () => !!await readFile(join(config, 'chat-runs', first.run.id, 'result.json'), 'utf8').catch(() => ''), 'detached native process finishes without controller');
  await boot();
  for (const requestId of ['first', 'second', 'third']) await awaitAnswer(session.id, requestId);
  const history = await rpc('history', session.id);
  assert.equal(history.filter(event => event.type === 'message' && event.role === 'user').length, 3);
  assert.equal(history.filter(event => event.type === 'message' && event.role === 'assistant' && event.content === 'durable native answer').length, 1);
  const claim = await rpc('claim', { connector: 'feishu' });
  assert.equal(claim.delivery.text, 'durable native answer');
  await rpc('complete', claim.delivery.id, claim.leaseId, { externalId: 'one-final-reply' });
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'same conversation gets one final publication for all steered messages');
  await evidence('PASS: SIGKILL/controller recovery preserved one execution and one copy of each accepted input; all three response addresses share one final answer and one Feishu publication.');

  const raceSession = await rpc('create');
  const raceRoot = await accept(raceSession.id, 'race-first', 'Start a completion-race turn');
  await until(async () => (await logs()).some(event => event.runId === raceRoot.run.id && event.kind === 'turn/start'), 'race turn started');
  await accept(raceSession.id, 'race-followup', 'RACE_NATIVE_COMPLETION');
  await until(async () => (await receipt(raceRoot.run.id, 'race-followup'))?.state === 'accepted', 'completion-race input safely starts native follow-up');
  const raceLog = (await logs()).filter(event => event.runId === raceRoot.run.id);
  assert.equal(raceLog.filter(event => event.kind === 'process-start').length, 1);
  assert.equal(raceLog.filter(event => event.kind === 'turn/start').length, 2);
  assert.equal(raceLog.filter(event => event.kind === 'turn/steer').length, 1);
  await writeFile(join(root, `${raceRoot.run.id}.release`), '');
  await awaitAnswer(raceSession.id, 'race-first'); await awaitAnswer(raceSession.id, 'race-followup');
  await evidence('PASS: explicit no-active-turn rejection during the completion race started the follow-up once in the existing Harness, without losing the input or launching a duplicate process.');

  const rejectedSession = await rpc('create');
  const rejectedRoot = await accept(rejectedSession.id, 'reject-first', 'Keep the valid root running');
  await until(async () => (await logs()).some(event => event.runId === rejectedRoot.run.id && event.kind === 'turn/start'), 'rejection test root started');
  await accept(rejectedSession.id, 'reject-input', 'REJECT_NATIVE_INPUT');
  await until(async () => (await rpc('response', rejectedSession.id, 'reject-input'))?.state === 'failed', 'definite native rejection settles just that input');
  assert.equal((await rpc('response', rejectedSession.id, 'reject-first')).state, 'running');
  await accept(rejectedSession.id, 'reject-recovery', 'Valid correction after rejected input');
  await until(async () => (await receipt(rejectedRoot.run.id, 'reject-recovery'))?.state === 'accepted', 'valid correction follows native rejection');
  await writeFile(join(root, `${rejectedRoot.run.id}.release`), '');
  await awaitAnswer(rejectedSession.id, 'reject-first'); await awaitAnswer(rejectedSession.id, 'reject-recovery');
  const rejectedLog = (await logs()).filter(event => event.runId === rejectedRoot.run.id);
  assert.equal(rejectedLog.filter(event => event.kind === 'turn/steer' && event.clientId === 'reject-input').length, 1, 'a rejected input is never retried');
  assert.equal(rejectedLog.filter(event => event.kind === 'process-start').length, 1, 'input rejection does not restart the active Harness');
  await evidence('PASS: an explicit native input rejection fails only that request, preserves the active turn, and accepts the next valid correction without replay.');
  succeeded = true;
  await evidence(`test-native-harness-integration: ok; validation log: ${validationLog}`);
} catch (error) {
  await evidence(`FAIL: ${error.stack}\nRetained isolated state: ${root}`);
  throw error;
} finally {
  await killController();
  for (const entry of (await logs()).filter(event => event.kind === 'process-start')) {
    try { process.kill(entry.pid, 'SIGTERM'); } catch {}
  }
  if (succeeded) await rm(root, { recursive: true, force: true });
}
