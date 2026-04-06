#!/usr/bin/env node
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-usage-fallback-'));
  const configDir = join(home, '.config', 'remotelab');
  const instanceRoot = join(home, '.remotelab', 'instances', 'trial24');
  const instanceConfigDir = join(instanceRoot, 'config');
  const runDir = join(instanceConfigDir, 'chat-runs', 'run_abc123');

  mkdirSync(configDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    join(configDir, 'guest-instances.json'),
    JSON.stringify([
      {
        name: 'trial24',
        label: 'com.chatserver.trial24',
        port: 7711,
        hostname: 'trial24.example.com',
        instanceRoot,
        configDir: instanceConfigDir,
        memoryDir: join(instanceRoot, 'memory'),
        authFile: join(instanceConfigDir, 'auth.json'),
        publicBaseUrl: 'https://trial24.example.com',
        localBaseUrl: 'http://127.0.0.1:7711',
        createdAt: '2026-03-26T14:56:25.700Z',
      },
    ], null, 2),
    'utf8',
  );

  writeFileSync(join(instanceConfigDir, 'auth.json'), JSON.stringify({ token: 'trial-token' }, null, 2), 'utf8');
  writeFileSync(join(instanceConfigDir, 'auth-sessions.json'), JSON.stringify([], null, 2), 'utf8');
  writeFileSync(join(instanceConfigDir, 'chat-sessions.json'), JSON.stringify([], null, 2), 'utf8');

  writeFileSync(
    join(runDir, 'status.json'),
    JSON.stringify({
      id: 'run_abc123',
      sessionId: 'session-1',
      state: 'completed',
      tool: 'claude',
      model: 'claude-opus-4-6',
      finalizedAt: '2026-04-05T08:00:00.000Z',
    }, null, 2),
    'utf8',
  );
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({ completedAt: '2026-04-05T08:00:00.000Z' }, null, 2), 'utf8');
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ sessionId: 'session-1' }, null, 2), 'utf8');
  writeFileSync(
    join(runDir, 'spool.jsonl'),
    `${JSON.stringify({
      ts: '2026-04-05T08:00:00.000Z',
      stream: 'stdout',
      json: {
        type: 'result',
        total_cost_usd: 0.75,
        usage: {
          input_tokens: 120,
          output_tokens: 380,
        },
        modelUsage: {
          'claude-opus-4-6': {
            inputTokens: 120,
            outputTokens: 380,
            costUSD: 0.75,
          },
        },
      },
    })}\n`,
    'utf8',
  );

  return { home };
}

function main() {
  const { home } = setupTempHome();
  try {
    const output = execFileSync(
      process.execPath,
      [join(repoRoot, 'cli.js'), 'guest-instance', 'report', '--json'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: home,
        },
        encoding: 'utf8',
      },
    );

    const report = JSON.parse(output);
    const rows = report.instances || report.rows || [];
    const trial24 = rows.find((entry) => entry.name === 'trial24');

    assert.ok(trial24, 'report should include the trial instance');
    assert.equal(trial24.usageSummary?.totals?.totalTokens, 500, 'fallback should aggregate tokens from chat-runs spool');
    assert.equal(trial24.usageSummary?.totals?.costUsd, 0.75, 'fallback should aggregate cost from chat-runs spool');
    assert.equal(trial24.usageSummary?.byTool?.[0]?.key, 'claude', 'fallback should preserve tool breakdown');
    assert.equal(report.summary?.usage?.totalTokens, 500, 'fleet summary should include fallback usage totals');
    assert.equal(report.summary?.usage?.activeInstanceCount, 1, 'instance with fallback usage should count as active');

    console.log('test-guest-instance-usage-fallback: ok');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

main();
