#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'remotelab-session-preflight-'));
setIsolatedTestHome(root);
process.env.TZ = 'UTC';
const configDir = join(root, '.config', 'remotelab');
await mkdir(configDir, { recursive: true });
const configFile = join(configDir, 'session-start-preflight.json');
await writeFile(configFile, `${JSON.stringify({
  version: 1,
  enabled: true,
  prompt: 'probe',
  restartAnswers: ['2.5'],
  retryDelayMs: 60_000,
  maxAttempts: 3,
  timeZone: 'Asia/Shanghai',
  tools: ['codex'],
})}\n`);

const {
  appendSessionStartPreflightEvent,
  classifySessionStartPreflightAnswer,
  collectSessionStartPreflightStats,
  formatSessionStartPreflightActivity,
  readSessionStartPreflightPolicy,
} = await import('../chat/session-start-preflight.mjs');
const { runSessionStartPreflightCommand } = await import('../lib/session-start-preflight-command.mjs');

try {
  assert.equal((await readSessionStartPreflightPolicy({
    configFile, tool: 'codex', runtimeFamily: 'codex-json', model: 'gpt-test', freshProviderSession: true,
  })).retryDelayMs, 60_000);
  assert.equal(await readSessionStartPreflightPolicy({
    configFile, tool: 'codex', runtimeFamily: 'codex-json', model: 'gpt-test', freshProviderSession: false,
  }), null, 'resumed provider sessions must not repeat the gate');
  assert.equal(await readSessionStartPreflightPolicy({
    configFile,
    tool: 'codex',
    runtimeFamily: 'codex-json',
    model: 'gpt-test',
    freshProviderSession: true,
    internalOperation: 'context_compaction_worker',
    purpose: 'maintenance',
  }), null, 'silent maintenance work must not run startup preflight');
  assert.equal((await readSessionStartPreflightPolicy({
    configFile,
    tool: 'codex',
    runtimeFamily: 'codex-json',
    model: 'gpt-test',
    freshProviderSession: true,
    internalOperation: 'trigger_delivery',
    purpose: 'scheduled_user_work',
  }))?.enabled, true, 'scheduled user work may retain startup preflight even though delivery plumbing is internal');
  assert.equal(classifySessionStartPreflightAnswer('Gemini 2.5 Pro', { restartAnswers: ['2.5'] }).status, 'restart_required');
  assert.equal(classifySessionStartPreflightAnswer('3.1', { restartAnswers: ['2.5'] }).status, 'loaded');
  assert.equal(classifySessionStartPreflightAnswer('', { restartAnswers: ['2.5'] }).status, 'error');
  assert.match(formatSessionStartPreflightActivity({
    state: 'attempt', attempt: 1, maxAttempts: 3, prompt: 'Which model version?',
  }), /Probe: "Which model version\?"/);
  assert.match(formatSessionStartPreflightActivity({
    state: 'restart_required', attempt: 1, maxAttempts: 3, answer: '2.5', matchedAnswer: '2.5', retryDelayMs: 60_000,
  }), /trying a new one in 60 seconds/);
  assert.match(formatSessionStartPreflightActivity({
    state: 'loaded', attempt: 2, maxAttempts: 3, answer: '3.1', hadRestart: true,
  }), /passed in the replacement provider session with answer "3.1"/);
  assert.match(formatSessionStartPreflightActivity({
    state: 'exhausted', attempt: 3, maxAttempts: 3, answer: '2.5', matchedAnswer: '2.5', continuesRealRequest: true,
  }), /continuing with the original request instead of failing the run/);
  assert.match(formatSessionStartPreflightActivity({
    state: 'error', attempt: 1, maxAttempts: 3, reason: 'empty_answer', continuesRealRequest: true,
  }), /continuing with the original request instead of failing the run/);

  const eventsDir = join(root, 'events');
  const base = { day: '2026-09-17', timeZone: 'Asia/Shanghai', tool: 'codex', runtimeFamily: 'codex-json', model: 'gpt-test' };
  for (const event of [
    { ...base, runId: 'normal', type: 'started', timestamp: '2026-09-17T01:00:00.000Z' },
    { ...base, runId: 'normal', type: 'attempt', attempt: 1, status: 'loaded', timestamp: '2026-09-17T01:00:01.000Z' },
    { ...base, runId: 'normal', type: 'completed', outcome: 'loaded_first_attempt', timestamp: '2026-09-17T01:00:02.000Z' },
    { ...base, runId: 'retry', type: 'started', timestamp: '2026-09-17T02:00:00.000Z' },
    { ...base, runId: 'retry', type: 'attempt', attempt: 1, status: 'restart_required', timestamp: '2026-09-17T02:00:01.000Z' },
    { ...base, runId: 'retry', type: 'attempt', attempt: 2, status: 'loaded', timestamp: '2026-09-17T02:01:02.000Z' },
    { ...base, runId: 'retry', type: 'completed', outcome: 'loaded_after_restart', timestamp: '2026-09-17T02:01:03.000Z' },
  ]) await appendSessionStartPreflightEvent(event, { eventsDir, day: event.day, timeZone: event.timeZone });

  const summary = await collectSessionStartPreflightStats({
    configFile,
    eventsDir,
    days: 1,
    now: new Date('2026-09-17T12:00:00.000Z'),
  });
  assert.equal(summary.totals.triggered, 2);
  assert.equal(summary.totals.normalLoads, 1);
  assert.equal(summary.totals.neededNewSession, 1);
  assert.equal(summary.totals.loadedAfterRestart, 1);
  assert.equal(summary.totals.neededNewSessionRate, 0.5);
  assert.equal(summary.totals.normalLoadRate, 0.5);

  let output = '';
  await runSessionStartPreflightCommand(['status', '--json'], { stdout: { write: (value) => { output += value; } } });
  assert.equal(JSON.parse(output).enabled, true);
  console.log('session start preflight: policy selection, answer classification, daily aggregation and CLI passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
