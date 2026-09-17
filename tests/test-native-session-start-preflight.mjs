#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'remotelab-native-preflight-'));
const command = join(root, 'fake-codex');
await copyFile(join(repo, 'tests/fixtures/native-codex-preflight-app-server.cjs'), command);
await chmod(command, 0o755);
const { runNativeHost } = await import('../chat/native-host.mjs');

async function runCase(name, preflightAnswer) {
  const directory = join(root, name);
  const logPath = join(root, `${name}.jsonl`);
  await mkdir(directory, { recursive: true });
  const events = [];
  const result = await runNativeHost({
    directory,
    command,
    runtimeFamily: 'codex-json',
    options: { requestId: `${name}-request` },
    prompt: 'REAL_USER_PROMPT',
    cwd: root,
    env: { ...process.env, PREFLIGHT_ANSWER: preflightAnswer, PREFLIGHT_LOG: logPath },
    startPreflight: { prompt: 'PREFLIGHT_MARKER', restartAnswers: ['2.5'] },
    onStdout: async (line) => events.push(JSON.parse(line)),
    onStderr: async () => {},
    onProcess: async () => {},
  });
  const prompts = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { result, events, prompts };
}

try {
  const loaded = await runCase('loaded', '3.1');
  assert.equal(loaded.result.code, 0);
  assert.equal(loaded.result.preflight.status, 'loaded');
  assert.deepEqual(loaded.prompts.map((entry) => entry.text), ['PREFLIGHT_MARKER', 'REAL_USER_PROMPT']);
  assert.deepEqual(
    loaded.events.filter((event) => event.type === 'item.completed').map((event) => event.item.text),
    ['actual visible answer'],
    'preflight answer must stay outside the visible run spool',
  );
  assert.equal(loaded.events.filter((event) => event.type === 'thread.started').length, 1,
    'accepted provider identity remains available for resume persistence');

  const stale = await runCase('stale', '2.5');
  assert.equal(stale.result.code, 0);
  assert.equal(stale.result.preflight.status, 'restart_required');
  assert.deepEqual(stale.prompts.map((entry) => entry.text), ['PREFLIGHT_MARKER']);
  assert.equal(stale.events.filter((event) => event.type === 'item.completed').length, 0,
    'a stale provider session must never receive the real user prompt');
  console.log('native session start preflight: hidden pass-through and stale-session rejection passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
