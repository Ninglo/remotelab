#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-usage-ledger-'));

process.env.HOME = tempHome;
process.env.REMOTELAB_CONFIG_DIR = join(tempHome, '.config', 'remotelab');
process.env.REMOTELAB_USAGE_LEDGER_DIR = join(tempHome, '.config', 'remotelab', 'usage-ledger');

const usageLedger = await import(
  pathToFileURL(join(repoRoot, 'chat', 'usage-ledger.mjs')).href
);
const { USAGE_LEDGER_DIR } = await import(
  pathToFileURL(join(repoRoot, 'lib', 'config.mjs')).href
);

function appendBuiltRecord(input) {
  const record = usageLedger.buildUsageLedgerRecord(input);
  assert.ok(record, 'usage record should be built');
  assert.equal(usageLedger.appendUsageLedgerRecord(record), true, 'usage record should append');
}

function formatLocalDay(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}.jsonl`;
}

try {
  await usageLedger.initUsageLedger();

  appendBuiltRecord({
    session: {
      id: 'sess_owner',
      name: 'Owner Session',
      tool: 'claude',
    },
    run: {
      id: 'run_owner',
      tool: 'claude',
      model: 'claude-sonnet',
      effort: 'high',
      state: 'completed',
      completedAt: '2026-04-05T12:00:00.000Z',
    },
    usageEvent: {
      inputTokens: 120,
      outputTokens: 30,
      contextTokens: 400,
      contextWindowTokens: 200000,
      costUsd: 0.25,
      contextSource: 'provider_turn_usage',
    },
    manifest: {},
  });

  appendBuiltRecord({
    session: {
      id: 'sess_visitor',
      name: 'Visitor Session',
      tool: 'claude',
      visitorId: 'visitor_1',
      visitorName: 'Alice',
    },
    run: {
      id: 'run_visitor',
      tool: 'claude',
      model: 'claude-sonnet',
      state: 'completed',
      completedAt: '2026-04-05T14:00:00.000Z',
    },
    usageEvent: {
      inputTokens: 300,
      outputTokens: 50,
      contextTokens: 700,
      costUsd: 0.75,
    },
    manifest: {},
  });

  appendBuiltRecord({
    session: {
      id: 'sess_user',
      name: 'User Session',
      tool: 'claude',
      userId: 'user_1',
      userName: 'Bob',
      visitorId: 'visitor_shadow',
      visitorName: 'Shadow',
    },
    run: {
      id: 'run_user',
      tool: 'claude',
      model: 'claude-opus',
      state: 'completed',
      completedAt: '2026-04-04T10:00:00.000Z',
    },
    usageEvent: {
      inputTokens: 500,
      outputTokens: 100,
      contextTokens: 900,
      costUsd: 1.5,
    },
    manifest: {},
  });

  appendBuiltRecord({
    session: {
      id: 'sess_internal',
      name: 'Internal Session',
      tool: 'claude',
      internalRole: 'context_compactor',
    },
    run: {
      id: 'run_internal',
      tool: 'claude',
      model: 'claude-sonnet',
      state: 'completed',
      completedAt: '2026-04-05T15:00:00.000Z',
    },
    usageEvent: {
      inputTokens: 20,
      outputTokens: 20,
      contextTokens: 100,
      costUsd: 0.05,
    },
    manifest: {
      internalOperation: 'reply_self_check',
    },
  });

  appendBuiltRecord({
    session: {
      id: 'sess_codex',
      name: 'Codex Session',
      tool: 'codex',
    },
    run: {
      id: 'run_codex_estimated',
      tool: 'codex',
      model: 'gpt-5.4',
      state: 'completed',
      completedAt: '2026-04-05T13:00:00.000Z',
    },
    usageEvent: {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 6,
      reasoningTokens: 2,
      contextTokens: 120,
      estimatedCostUsd: 0.002,
      estimatedCostModel: 'gpt-5.4',
      costSource: 'estimated_gpt_5_4',
    },
    manifest: {},
  });

  const detachedRecord = usageLedger.buildDetachedUsageLedgerRecord({
    session: {
      id: 'sess_owner',
      name: 'Owner Session',
      tool: 'claude',
    },
    usageEvent: {
      inputTokens: 40,
      outputTokens: 10,
      contextTokens: 150,
      estimatedCostUsd: 0.01,
      estimatedCostModel: 'claude-sonnet',
      costSource: 'estimated_background',
    },
    tracking: {
      operation: 'session_label_suggestion',
      tool: 'claude',
      model: 'claude-sonnet',
      effort: 'low',
      completedAt: '2026-04-05T11:30:00.000Z',
    },
  });
  assert.ok(detachedRecord, 'detached prompt record should be built');
  assert.equal(usageLedger.appendUsageLedgerRecord(detachedRecord), true, 'detached prompt record should append');

  assert.equal(usageLedger.appendUsageLedgerRecord({
    ts: '2026-04-05T16:00:00.000Z',
    runId: 'run_owner_fallback',
    sessionId: 'sess-owner-fallback',
    sessionName: 'Owner fallback session',
    principalType: 'owner',
    principalId: 'owner',
    principalName: 'Owner',
    tool: 'claude',
    model: 'opus',
    state: 'completed',
    totalTokens: 1500,
    inputTokens: 1000,
    outputTokens: 500,
    operation: 'user_turn',
  }), true, 'raw ledger records should still append so read-time fallback estimation can cover them');

  assert.equal(usageLedger.appendUsageLedgerRecord({
    ts: '2026-04-05T16:30:00.000Z',
    runId: 'run_unknown_unpriced',
    sessionId: 'sess-unknown',
    sessionName: 'Unknown model session',
    principalType: 'owner',
    principalId: 'owner',
    principalName: 'Owner',
    tool: 'custom-tool',
    model: 'custom-model',
    state: 'completed',
    totalTokens: 20,
    inputTokens: 10,
    outputTokens: 10,
    operation: 'user_turn',
  }), true, 'usage without a known price table should still remain visible');

  // Duplicate run id should collapse to the latest appended record at query time.
  appendBuiltRecord({
    session: {
      id: 'sess_visitor',
      name: 'Visitor Session',
      tool: 'claude',
      visitorId: 'visitor_1',
      visitorName: 'Alice',
    },
    run: {
      id: 'run_visitor',
      tool: 'claude',
      model: 'claude-sonnet',
      state: 'completed',
      completedAt: '2026-04-05T14:05:00.000Z',
    },
    usageEvent: {
      inputTokens: 300,
      outputTokens: 60,
      contextTokens: 720,
      costUsd: 0.8,
    },
    manifest: {},
  });

  await usageLedger.closeUsageLedger();

  const files = readdirSync(USAGE_LEDGER_DIR).sort();
  const expectedFiles = [
    formatLocalDay('2026-04-04T10:00:00.000Z'),
    formatLocalDay('2026-04-05T12:00:00.000Z'),
    formatLocalDay('2026-04-05T16:00:00.000Z'),
  ].sort();
  assert.deepEqual(files, expectedFiles, 'usage ledger should rotate by local day');

  const summary = await usageLedger.queryUsageLedger({
    days: 3,
    endMs: Date.parse('2026-04-06T12:00:00.000Z'),
    top: 10,
  });

  assert.equal(summary.runCount, 8, 'duplicate run ids should collapse during summary');
  assert.equal(summary.totals.inputTokens, 2000, 'input tokens should aggregate across unique runs');
  assert.equal(summary.totals.outputTokens, 735, 'output tokens should aggregate across unique runs');
  assert.equal(summary.totals.totalTokens, 2735, 'total tokens should aggregate across unique runs');
  assert.equal(summary.totals.costUsd, 2.6, 'cost should aggregate across unique runs');
  assert.equal(summary.totals.estimatedCostUsd, 0.0295, 'estimated cost should aggregate separately from exact cost, including fallback estimates');
  assert.equal(summary.totals.costedRunCount, 7, 'coverage metrics should count runs with provider or fallback pricing');
  assert.equal(summary.totals.unpricedRunCount, 1, 'coverage metrics should keep unknown-price runs visible');
  assert.equal(summary.totals.costedTokenCount, 2715, 'coverage metrics should count tokens that received a price');
  assert.equal(summary.totals.unpricedTokenCount, 20, 'coverage metrics should expose token volume missing a price table');
  assert.equal(summary.totals.costCoverageShare, 0.9927, 'coverage metrics should summarize priced-token coverage');
  assert.equal(summary.totals.cachedInputTokens, 6, 'cached input tokens should aggregate across unique runs');
  assert.equal(summary.totals.reasoningTokens, 2, 'reasoning tokens should aggregate across unique runs');
  assert.equal(summary.totals.maxContextTokens, 900, 'peak context should be preserved');
  assert.equal(summary.totals.maxContextWindowTokens, 200000, 'peak context window should be preserved');
  assert.equal(summary.totals.backgroundTokens, 90, 'background tokens should aggregate across internal and detached runs');
  assert.equal(summary.totals.foregroundTokens, 2645, 'foreground tokens should aggregate user-facing runs');

  assert.equal(summary.byPrincipal[0].principalType, 'owner', 'principal buckets should sort by total usage after fallback-estimated owner traffic is included');
  assert.equal(summary.byPrincipal[0].principalId, 'owner');
  assert.equal(summary.byPrincipal[0].totalTokens, 1775);

  const visitorBucket = summary.byPrincipal.find((bucket) => bucket.principalId === 'visitor_1');
  assert.equal(visitorBucket?.totalTokens, 360, 'visitor bucket should reflect the deduped latest run');
  assert.equal(visitorBucket?.costUsd, 0.8, 'visitor cost should reflect the deduped latest run');

  const ownerBucket = summary.byPrincipal.find((bucket) => bucket.principalId === 'owner');
  assert.equal(ownerBucket?.totalTokens, 1775, 'owner bucket should include direct, internal, detached, fallback-estimated, and unpriced owner runs');
  assert.equal(ownerBucket?.estimatedCostUsd, 0.0295, 'owner bucket should preserve detached and fallback estimated cost separately');

  const replySelfCheckBucket = summary.byOperation.find((bucket) => bucket.key === 'reply_self_check');
  assert.equal(replySelfCheckBucket?.totalTokens, 40, 'internal operations should remain queryable');
  const labelSuggestionBucket = summary.byOperation.find((bucket) => bucket.key === 'session_label_suggestion');
  assert.equal(labelSuggestionBucket?.totalTokens, 50, 'detached prompt operations should be queryable');
  const backgroundBucket = summary.byOperationGroup.find((bucket) => bucket.key === 'background');
  assert.equal(backgroundBucket?.totalTokens, 90, 'operation groups should separate background usage');
  const sessionManagementBucket = summary.byOperationCategory.find((bucket) => bucket.key === 'session_management');
  assert.equal(sessionManagementBucket?.totalTokens, 50, 'operation categories should group detached session-management usage');

  const visitorOnly = await usageLedger.queryUsageLedger({
    days: 3,
    endMs: Date.parse('2026-04-06T12:00:00.000Z'),
    principalType: 'visitor',
    principalId: 'visitor_1',
  });
  assert.equal(visitorOnly.runCount, 1, 'principal filters should constrain the summary');
  assert.equal(visitorOnly.totals.totalTokens, 360);

  console.log('test-usage-ledger: ok');
} finally {
  await usageLedger.closeUsageLedger();
  rmSync(tempHome, { recursive: true, force: true });
}
