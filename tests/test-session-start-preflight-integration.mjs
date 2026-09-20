#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fork } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const execFileAsync = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'remotelab-preflight-integration-'));
const config = join(root, 'config');
const bin = join(root, 'bin');
const logPath = join(root, 'provider-prompts.jsonl');
const sequenceFile = join(root, 'provider-sequence.txt');
await mkdir(config); await mkdir(bin);
await copyFile(join(repo, 'tests/fixtures/native-codex-preflight-app-server.cjs'), join(bin, 'fake-native'));
await chmod(join(bin, 'fake-native'), 0o755);
await writeFile(join(config, 'tools.json'), JSON.stringify([{
  id: 'fake-native', name: 'Fake native', command: 'fake-native', runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user',
}]));
await writeFile(join(config, 'session-start-preflight.json'), JSON.stringify({
  version: 1,
  enabled: true,
  prompt: 'PREFLIGHT_MARKER',
  restartAnswers: ['2.5'],
  retryDelayMs: 0,
  maxAttempts: 3,
  timeZone: 'UTC',
  tools: ['fake-native'],
  includeInternalOperations: true,
}));

const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  HOME: root,
  SHELL: '/bin/sh',
  REMOTELAB_CONFIG_DIR: config,
  REMOTELAB_MEMORY_DIR: join(root, 'memory'),
  REMOTELAB_WORK_ROOT_DIR: root,
  REMOTELAB_MEMORY_WRITEBACK: 'off',
  REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
  REMOTELAB_USER_SHELL_ENV_B64: Buffer.from(JSON.stringify({ shell: '/bin/sh', mode: 'test', env: {} })).toString('base64'),
  PREFLIGHT_LOG: logPath,
  PREFLIGHT_SEQUENCE_FILE: sequenceFile,
};

const child = fork(join(repo, 'tests/fixtures/native-codex-controller.mjs'), [], {
  cwd: repo,
  env,
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
});
let errors = '';
child.stderr.on('data', (chunk) => { errors += chunk; });
const pending = new Map();
let rpcSequence = 0;
child.on('message', (message) => {
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
});
child.on('exit', () => {
  for (const request of pending.values()) request.reject(new Error(`Controller exited: ${errors}`));
  pending.clear();
});
const rpc = (action, ...args) => new Promise((resolve, reject) => {
  const id = ++rpcSequence;
  pending.set(id, { resolve, reject });
  child.send({ id, action, args });
});
const until = async (predicate, label) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}: ${errors}`);
};

try {
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(errors); })]);
  const session = await rpc('create');
  const accepted = await rpc('accept', session.id, 'REAL_USER_PROMPT', [], { requestId: 'preflight-integration' });
  await until(async () => (await rpc('response', session.id, 'preflight-integration'))?.state === 'ready', 'preflight-protected answer');
  const response = await rpc('response', session.id, 'preflight-integration');
  assert.equal(response.payload.text, 'actual visible answer');
  const history = await rpc('history', session.id);
  assert.deepEqual(
    history.filter((event) => event.type === 'message' && event.role === 'assistant').map((event) => event.content),
    ['actual visible answer'],
    'probe replies stay out of canonical assistant messages',
  );
  const preflightThought = history
    .filter((event) => event.type === 'reasoning')
    .map((event) => event.content)
    .join('\n');
  assert.match(preflightThought, /Probe: "PREFLIGHT_MARKER"/);
  assert.match(preflightThought, /matching the configured stale marker "2.5"/);
  assert.match(preflightThought, /preflight retry \(attempt 2\/3\)/i);
  assert.match(preflightThought, /passed in the replacement provider session with answer "3.1"/);
  const prompts = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(prompts.map((entry) => entry.text), ['PREFLIGHT_MARKER', 'PREFLIGHT_MARKER', 'REAL_USER_PROMPT']);

  const { stdout } = await execFileAsync(process.execPath, [join(repo, 'cli.js'), 'session-preflight', 'stats', '--days', '1', '--json'], { env });
  const stats = JSON.parse(stdout);
  assert.equal(stats.totals.triggered, 1);
  assert.equal(stats.totals.normalLoads, 0);
  assert.equal(stats.totals.neededNewSession, 1);
  assert.equal(stats.totals.loadedAfterRestart, 1);
  assert.equal(stats.totals.neededNewSessionRate, 1);
  assert.equal(accepted.run.id.length > 0, true);
  console.log('session start preflight integration: stale provider replaced, real prompt isolated, daily statistics verified');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
