#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-usage-context-'));

process.env.HOME = tempHome;
process.env.REMOTELAB_CONFIG_DIR = join(tempHome, '.config', 'remotelab');
process.env.CODEX_HOME = join(tempHome, '.config', 'remotelab', 'provider-runtime-homes', 'codex');

const { createClaudeAdapter } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'adapters', 'claude.mjs')).href
);
const { createCodexAdapter } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'adapters', 'codex.mjs')).href
);
const {
  buildCodexContextMetricsPayload,
  readLatestCodexSessionMetrics,
} = await import(
  pathToFileURL(join(repoRoot, 'chat', 'codex-session-metrics.mjs')).href
);
const { createShareSnapshot } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'shares.mjs')).href
);
const { CHAT_SHARE_SNAPSHOTS_DIR } = await import(
  pathToFileURL(join(repoRoot, 'lib', 'config.mjs')).href
);

try {
  const claude = createClaudeAdapter();
  claude.parseLine(JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Done.' }],
      usage: {
        input_tokens: 1200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 450,
      },
    },
  }));

  const claudeUsageEvents = claude.parseLine(JSON.stringify({
    type: 'result',
    cost_usd: 0.012345,
    usage: {
      input_tokens: 1200,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 450,
      output_tokens: 80,
    },
  }));
  const claudeUsage = claudeUsageEvents.find((event) => event.type === 'usage');

  assert.ok(claudeUsage, 'Claude adapter should emit a usage event');
  assert.equal(claudeUsage.contextTokens, 1950, 'Claude context size should include cached tokens');
  assert.equal(claudeUsage.inputTokens, 1200, 'Claude inputTokens should preserve raw provider input');
  assert.equal(claudeUsage.outputTokens, 80, 'Claude outputTokens should be preserved');
  assert.equal(claudeUsage.costUsd, 0.012345, 'Claude usage should preserve provider cost when available');
  assert.equal(claudeUsage.contextSource, 'provider_turn_usage', 'Claude usage should identify its context source');
  assert.equal(claudeUsage.costSource, 'provider_reported', 'Claude usage should label exact provider-reported cost');

  const codex = createCodexAdapter();
  const codexRawUsageEvents = codex.parseLine(JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 8068,
      cached_input_tokens: 7040,
      output_tokens: 31,
    },
  }));
  const codexUsageFromRawStdout = codexRawUsageEvents.find((event) => event.type === 'usage');

  assert.equal(codexUsageFromRawStdout, undefined, 'Codex raw turn.completed usage should not masquerade as live context');

  const codexThreadId = '019cd5f7-3c2b-7571-bb3c-9cde8f3a6598';
  const codexSessionDir = join(tempHome, '.codex', 'sessions', '2026', '03', '10');
  mkdirSync(codexSessionDir, { recursive: true });
  writeFileSync(join(codexSessionDir, `rollout-2026-03-10T12-17-55-${codexThreadId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-03-10T04:18:13.710Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 35991,
            cached_input_tokens: 25472,
            output_tokens: 442,
            reasoning_output_tokens: 269,
            total_tokens: 36433,
          },
          last_token_usage: {
            input_tokens: 12225,
            cached_input_tokens: 11904,
            output_tokens: 50,
            reasoning_output_tokens: 0,
            total_tokens: 12275,
          },
          model_context_window: 258400,
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-10T04:18:17.666Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 48317,
            cached_input_tokens: 37632,
            output_tokens: 531,
            reasoning_output_tokens: 269,
            total_tokens: 48848,
          },
          last_token_usage: {
            input_tokens: 12326,
            cached_input_tokens: 12160,
            output_tokens: 89,
            reasoning_output_tokens: 0,
            total_tokens: 12415,
          },
          model_context_window: 258400,
        },
      },
    }),
  ].join('\n'), 'utf8');

  const codexMetrics = await readLatestCodexSessionMetrics(codexThreadId);
  assert.ok(codexMetrics, 'Codex session metrics should be readable from the session JSONL');
  assert.equal(codexMetrics.contextTokens, 12326, 'Codex live context should use last_token_usage.input_tokens');
  assert.equal(codexMetrics.inputTokens, 48317, 'Codex raw turn input should preserve total_token_usage.input_tokens');
  assert.equal(codexMetrics.cachedInputTokens, 37632, 'Codex cached input tokens should be preserved when available');
  assert.equal(codexMetrics.outputTokens, 531, 'Codex output tokens should preserve total_token_usage.output_tokens');
  assert.equal(codexMetrics.reasoningTokens, 269, 'Codex reasoning output tokens should be preserved when available');
  assert.equal(codexMetrics.contextWindowTokens, 258400, 'Codex context window should be preserved when available');
  assert.equal(codexMetrics.estimatedCostUsd, 0.044086, 'Codex metrics should estimate GPT-5.4 cost from input/cache/output tokens');
  assert.equal(codexMetrics.estimatedCostModel, 'gpt-5.4', 'Codex metrics should annotate the pricing model assumption');
  assert.equal(codexMetrics.costSource, 'estimated_gpt_5_4', 'Codex metrics should expose the estimate source');

  const managedCodexThreadId = '019d6383-beec-7ae2-9b12-264f2fcf075b';
  const managedCodexSessionDir = join(
    tempHome,
    '.config',
    'remotelab',
    'provider-runtime-homes',
    'codex',
    'sessions',
    '2026',
    '04',
    '06',
  );
  mkdirSync(managedCodexSessionDir, { recursive: true });
  writeFileSync(join(managedCodexSessionDir, `rollout-2026-04-06T23-57-51-${managedCodexThreadId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-04-08T13:20:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 14900000,
            cached_input_tokens: 12490000,
            output_tokens: 90000,
            reasoning_output_tokens: 47000,
            total_tokens: 14990000,
          },
          last_token_usage: {
            input_tokens: 180000,
            cached_input_tokens: 179500,
            output_tokens: 120,
            reasoning_output_tokens: 40,
            total_tokens: 180120,
          },
          model_context_window: 258400,
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-04-08T13:30:25.812Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 14976327,
            cached_input_tokens: 12550016,
            output_tokens: 91640,
            reasoning_output_tokens: 48023,
            total_tokens: 15067967,
          },
          last_token_usage: {
            input_tokens: 181995,
            cached_input_tokens: 181248,
            output_tokens: 139,
            reasoning_output_tokens: 52,
            total_tokens: 182134,
          },
          model_context_window: 258400,
        },
      },
    }),
  ].join('\n'), 'utf8');

  const managedCodexMetrics = await readLatestCodexSessionMetrics(managedCodexThreadId, {
    startedAt: '2026-04-08T13:26:40.349Z',
    completedAt: '2026-04-08T13:30:26.950Z',
  });
  assert.ok(managedCodexMetrics, 'Codex session metrics should also be readable from the managed runtime home');
  assert.equal(
    managedCodexMetrics.sessionLogPath,
    join(managedCodexSessionDir, `rollout-2026-04-06T23-57-51-${managedCodexThreadId}.jsonl`),
    'Codex metrics should resolve the managed runtime session log path',
  );
  assert.equal(
    managedCodexMetrics.contextTokens,
    181995,
    'Managed-home Codex metrics should use last_token_usage.input_tokens',
  );
  assert.equal(
    managedCodexMetrics.inputTokens,
    76327,
    'Managed-home Codex metrics should diff cumulative totals into per-run input tokens',
  );
  assert.equal(
    managedCodexMetrics.cachedInputTokens,
    60016,
    'Managed-home Codex metrics should diff cumulative totals into per-run cached input tokens',
  );
  assert.equal(
    managedCodexMetrics.outputTokens,
    1640,
    'Managed-home Codex metrics should diff cumulative totals into per-run output tokens',
  );

  const codexUsageEvents = codex.parseLine(JSON.stringify(buildCodexContextMetricsPayload(codexMetrics)));
  const codexUsage = codexUsageEvents.find((event) => event.type === 'usage');

  assert.ok(codexUsage, 'Codex adapter should emit a usage event from RemoteLab-injected context metrics');
  assert.equal(codexUsage.contextTokens, 12326, 'Codex usage should use the latest live context size');
  assert.equal(codexUsage.inputTokens, 48317, 'Codex usage should preserve raw turn input for diagnostics');
  assert.equal(codexUsage.cachedInputTokens, 37632, 'Codex usage should preserve cached input tokens');
  assert.equal(codexUsage.outputTokens, 531, 'Codex usage should preserve total turn output');
  assert.equal(codexUsage.reasoningTokens, 269, 'Codex usage should preserve reasoning output tokens');
  assert.equal(codexUsage.contextWindowTokens, 258400, 'Codex usage should carry context window when available');
  assert.equal(codexUsage.contextSource, 'provider_last_token_count', 'Codex usage should identify the provider-backed context source');
  assert.equal(codexUsage.estimatedCostUsd, 0.044086, 'Codex usage should carry the GPT-5.4 estimated cost');
  assert.equal(codexUsage.estimatedCostModel, 'gpt-5.4', 'Codex usage should annotate the estimated pricing model');
  assert.equal(codexUsage.costSource, 'estimated_gpt_5_4', 'Codex usage should identify the estimated cost source');

  const snapshot = await createShareSnapshot(
    { name: 'Usage test', tool: 'codex', created: new Date().toISOString() },
    [
      {
        type: 'usage',
        id: 'evt_legacy',
        timestamp: 1,
        role: 'system',
        inputTokens: 321,
        outputTokens: 12,
      },
      {
        type: 'usage',
        id: 'evt_new',
        timestamp: 2,
        role: 'system',
        contextTokens: 654,
        inputTokens: 111,
        cachedInputTokens: 44,
        outputTokens: 22,
        reasoningTokens: 7,
        estimatedCostUsd: 0.001234,
        estimatedCostModel: 'gpt-5.4',
        contextWindowTokens: 258400,
        contextSource: 'provider_last_token_count',
        costSource: 'estimated_gpt_5_4',
      },
      {
        type: 'usage',
        id: 'evt_no_context',
        timestamp: 3,
        role: 'system',
        inputTokens: 999,
        outputTokens: 33,
        contextSource: 'provider_last_token_count',
      },
    ],
  );

  const stored = JSON.parse(
    readFileSync(join(CHAT_SHARE_SNAPSHOTS_DIR, `${snapshot.id}.json`), 'utf8'),
  );
  const [legacyUsage, newUsage, noContextUsage] = stored.events;

  assert.equal(legacyUsage.contextTokens, undefined, 'usage events without explicit contextTokens should stay unlabeled');
  assert.equal(newUsage.contextTokens, 654, 'new usage events should preserve explicit contextTokens');
  assert.equal(newUsage.cachedInputTokens, 44, 'new usage events should preserve cached input tokens');
  assert.equal(newUsage.reasoningTokens, 7, 'new usage events should preserve reasoning token counts');
  assert.equal(newUsage.estimatedCostUsd, 0.001234, 'new usage events should preserve estimated cost');
  assert.equal(newUsage.estimatedCostModel, 'gpt-5.4', 'new usage events should preserve estimated pricing model');
  assert.equal(newUsage.contextWindowTokens, 258400, 'new usage events should preserve context window data');
  assert.equal(newUsage.contextSource, 'provider_last_token_count', 'new usage events should preserve context source');
  assert.equal(newUsage.costSource, 'estimated_gpt_5_4', 'new usage events should preserve cost source');
  assert.equal(noContextUsage.contextTokens, undefined, 'new-source usage events should not fall back to raw input when live context is unavailable');

  console.log('test-usage-context-metric: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
