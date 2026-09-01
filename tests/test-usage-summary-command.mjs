#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-usage-summary-'));

function makeSessionPath(rootDir, threadId) {
  return join(rootDir, '2026', '03', '19', `rollout-2026-03-19T12-00-00-${threadId}.jsonl`);
}

function writeSessionFile(rootDir, threadId, lines) {
  const filePath = makeSessionPath(rootDir, threadId);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
}

process.env.HOME = tempHome;
process.env.REMOTELAB_MACHINE_CODEX_HOME = join(tempHome, '.codex');

const personalRoot = join(tempHome, '.codex', 'sessions');
const managedRoot = join(tempHome, '.config', 'remotelab', 'provider-runtime-homes', 'codex', 'sessions');

writeSessionFile(personalRoot, 'thread-personal', [
  {
    timestamp: '2026-03-19T00:00:00.000Z',
    type: 'turn_context',
    payload: { cwd: '/Users/test/repo-a', model: 'gpt-5.4', effort: 'xhigh' },
  },
  {
    timestamp: '2026-03-19T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: '先看一下 usage 到底烧在哪。' },
  },
  {
    timestamp: '2026-03-19T00:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: 110,
        },
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: 110,
        },
        model_context_window: 258400,
      },
      rate_limits: { secondary: { used_percent: 12 } },
    },
  },
  {
    timestamp: '2026-03-19T00:00:03.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: 110,
        },
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: 110,
        },
        model_context_window: 258400,
      },
      rate_limits: { secondary: { used_percent: 12 } },
    },
  },
  {
    timestamp: '2026-03-19T01:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: '再看看最近两天是不是都在 xhigh。' },
  },
  {
    timestamp: '2026-03-19T01:00:00.500Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'Warning: apply_patch was requested via shell. Use the apply_patch tool instead of exec_command.' },
  },
  {
    timestamp: '2026-03-19T01:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 180,
          cached_input_tokens: 120,
          output_tokens: 40,
          reasoning_output_tokens: 11,
          total_tokens: 220,
        },
        last_token_usage: {
          input_tokens: 80,
          cached_input_tokens: 60,
          output_tokens: 30,
          reasoning_output_tokens: 7,
          total_tokens: 110,
        },
        model_context_window: 258400,
      },
      rate_limits: { secondary: { used_percent: 18 } },
    },
  },
]);

writeSessionFile(managedRoot, 'thread-managed', [
  {
    timestamp: '2026-03-18T22:00:00.000Z',
    type: 'turn_context',
    payload: { cwd: '/Users/test/repo-b', model: 'gpt-5.4', effort: 'low' },
  },
  {
    timestamp: '2026-03-18T22:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: '[Manager turn policy reminder]\n\nCurrent user message:\nRemoteLab 这边也看一下。' },
  },
  {
    timestamp: '2026-03-18T22:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 30,
          cached_input_tokens: 10,
          output_tokens: 5,
          reasoning_output_tokens: 2,
          total_tokens: 35,
        },
        last_token_usage: {
          input_tokens: 30,
          cached_input_tokens: 10,
          output_tokens: 5,
          reasoning_output_tokens: 2,
          total_tokens: 35,
        },
        model_context_window: 258400,
      },
      rate_limits: { secondary: { used_percent: 21 } },
    },
  },
  {
    timestamp: '2026-03-19T02:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 80,
          cached_input_tokens: 40,
          output_tokens: 15,
          reasoning_output_tokens: 5,
          total_tokens: 95,
        },
        last_token_usage: {
          input_tokens: 50,
          cached_input_tokens: 30,
          output_tokens: 10,
          reasoning_output_tokens: 3,
          total_tokens: 60,
        },
        model_context_window: 258400,
      },
      rate_limits: { secondary: { used_percent: 25 } },
    },
  },
]);

const { collectCodexUsageSummary, renderCodexUsageSummary } = await import(
  pathToFileURL(join(repoRoot, 'lib', 'codex-usage-summary.mjs')).href
);
const { runUsageSummaryCommand } = await import(
  pathToFileURL(join(repoRoot, 'lib', 'usage-summary-command.mjs')).href
);

try {
  const summary = await collectCodexUsageSummary({
    days: 2,
    top: 5,
    nowMs: Date.parse('2026-03-19T12:00:00.000Z'),
  });

  assert.equal(summary.sessionsScanned, 1, 'only the machine Codex session tree should be scanned');
  assert.equal(summary.sessionsWithUsage, 1, 'the machine Codex session should contribute usage');
  assert.equal(summary.totalTokens, 220, 'summary should aggregate window deltas without counting duplicates');
  assert.equal(summary.inputTokens, 180, 'input deltas should aggregate correctly');
  assert.equal(summary.cachedInputTokens, 120, 'cached input deltas should aggregate correctly');
  assert.equal(summary.outputTokens, 40, 'output deltas should aggregate correctly');
  assert.equal(summary.reasoningTokens, 11, 'reasoning deltas should aggregate correctly');
  assert.equal(summary.latestSecondaryUsedPercent, 18, 'latest weekly snapshot should come from the machine Codex tree');
  assert.equal(summary.bySource[0].key, 'machine (~/.codex)', 'usage should report the one machine Codex source');
  assert.equal(summary.byEffort[0].key, 'xhigh', 'xhigh should sort ahead when it has more usage');
  assert.equal(summary.byModel[0].key, 'gpt-5.4', 'model aggregation should be preserved');
  assert.equal(summary.byCwd[0].key, '/Users/test/repo-a', 'cwd aggregation should preserve the top directory');
  assert.equal(summary.topSessions[0].promptPreview, '再看看最近两天是不是都在 xhigh。', 'top session should retain the latest contributing user prompt');

  const rendered = renderCodexUsageSummary(summary);
  assert.match(rendered, /Total tokens: 220/, 'text rendering should include total tokens');
  assert.match(rendered, /By effort:/, 'text rendering should include breakdown sections');

  let output = '';
  const stdout = { write(chunk) { output += chunk; } };
  const exitCode = await runUsageSummaryCommand(
    ['--days', '2', '--top', '3', '--now', '2026-03-19T12:00:00.000Z', '--json'],
    { stdout },
  );
  assert.equal(exitCode, 0, 'command should exit cleanly');
  const parsed = JSON.parse(output);
  assert.equal(parsed.totalTokens, 220, 'json command output should expose the aggregated totals');
  assert.equal(parsed.topSessions.length, 1, 'json command output should preserve top sessions');

  console.log('test-usage-summary-command: ok');
} finally {
  delete process.env.REMOTELAB_MACHINE_CODEX_HOME;
  rmSync(tempHome, { recursive: true, force: true });
}
