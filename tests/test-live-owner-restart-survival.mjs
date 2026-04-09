#!/usr/bin/env node
import assert from 'assert/strict';
import { execFile as execFileCallback } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import { createRemoteLabHttpClient } from '../lib/remotelab-http-client.mjs';

const execFileAsync = promisify(execFileCallback);

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const shouldRun = process.argv.includes('--live') || process.env.REMOTELAB_LIVE_RESTART_TEST === '1';
if (!shouldRun) {
  console.log('test-live-owner-restart-survival: skipped (set REMOTELAB_LIVE_RESTART_TEST=1 or pass --live)');
  process.exit(0);
}

const baseUrl = String(process.env.REMOTELAB_LIVE_BASE_URL || 'http://127.0.0.1:7690').trim();
const serviceName = String(process.env.REMOTELAB_LIVE_SERVICE || 'remotelab.service').trim();
const configDir = String(process.env.REMOTELAB_LIVE_CONFIG_DIR || join(homedir(), '.config', 'remotelab')).trim();
const runsDir = join(configDir, 'chat-runs');
const toolsFile = join(configDir, 'tools.json');
const tempDir = mkdtempSync(join(tmpdir(), 'remotelab-live-restart-'));
const fakeToolPath = join(tempDir, 'fake-codex-live-restart');
const toolId = 'fake-codex-live-restart';
const client = createRemoteLabHttpClient({ baseUrl });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 60_000, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

async function requestWithRetry(path, options, description, timeoutMs = 60_000, intervalMs = 500) {
  return waitFor(async () => {
    try {
      const result = await client.request(path, options);
      if (!result.response.ok) return false;
      return result;
    } catch {
      return false;
    }
  }, description, timeoutMs, intervalMs);
}

async function waitForRunState(runId, expectedStates, timeoutMs = 120_000, intervalMs = 800) {
  const acceptedStates = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
  return waitFor(async () => {
    try {
      const result = await client.request(`/api/runs/${encodeURIComponent(runId)}`);
      if (!result.response.ok || !result.json?.run) return false;
      if (!acceptedStates.includes(result.json.run.state)) return false;
      return result.json.run;
    } catch {
      return false;
    }
  }, `run ${runId} to enter ${acceptedStates.join(', ')}`, timeoutMs, intervalMs);
}

async function loadEvents(sessionId) {
  const result = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/events?filter=all`);
  assert.equal(result.response.status, 200, 'session events request should succeed');
  assert.ok(Array.isArray(result.json?.events), 'session events payload should include events');
  return result.json.events;
}

async function systemctl(args) {
  const command = process.getuid?.() === 0 ? 'systemctl' : 'sudo';
  const commandArgs = process.getuid?.() === 0 ? args : ['systemctl', ...args];
  return execFileAsync(command, commandArgs, { timeout: 60_000 });
}

function readToolsFile() {
  if (!existsSync(toolsFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(toolsFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeToolsFile(nextTools) {
  writeFileSync(toolsFile, `${JSON.stringify(nextTools, null, 2)}\n`, 'utf8');
}

function installLiveFakeTool() {
  writeFileSync(
    fakeToolPath,
    `#!/usr/bin/env node
const delay = Number(process.env.FAKE_CODEX_DELAY_MS || '6000');
const firstStepDelay = Math.max(300, Math.min(delay - 500, Math.floor(delay * 0.3)));
let cancelled = false;
process.on('SIGTERM', () => {
  cancelled = true;
  setTimeout(() => process.exit(143), 20);
});
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-live-restart' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  if (cancelled) return;
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'echo fake-live', aggregated_output: 'fake-live', exit_code: 0, status: 'completed' }
  }));
}, firstStepDelay);
setTimeout(() => {
  if (cancelled) return;
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'finished from live restart fake codex' }
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 }
  }));
}, delay);
`,
    'utf8',
  );
  chmodSync(fakeToolPath, 0o755);

  const tools = readToolsFile().filter((tool) => tool?.id !== toolId && String(tool?.command || '').trim() !== fakeToolPath);
  tools.push({
    id: toolId,
    name: 'Fake Codex Live Restart',
    command: fakeToolPath,
    runtimeFamily: 'codex-json',
    models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
    reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
  });
  writeToolsFile(tools);
}

function removeLiveFakeTool() {
  if (existsSync(toolsFile)) {
    const filtered = readToolsFile().filter((tool) => tool?.id !== toolId && String(tool?.command || '').trim() !== fakeToolPath);
    if (filtered.length > 0) {
      writeToolsFile(filtered);
    } else {
      rmSync(toolsFile, { force: true });
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
}

async function main() {
  installLiveFakeTool();
  let sessionId = '';
  let runId = '';
  try {
    await requestWithRetry('/api/auth/me', {}, 'owner service to respond before live restart test');
    const beforePid = (await systemctl(['show', '--property=MainPID', '--value', serviceName])).stdout.trim();

    await waitFor(async () => {
      const result = await client.request('/api/tools').catch(() => null);
      return result?.response?.ok && result.json?.tools?.some((tool) => tool.id === toolId) ? result : false;
    }, 'live fake tool to appear in tool list');

    const createSession = await client.request('/api/sessions', {
      method: 'POST',
      body: {
        folder: repoRoot,
        tool: toolId,
        name: `Live Restart Survival ${Date.now()}`,
        group: 'Tests',
        description: 'Live owner restart survival validation',
      },
    });
    assert.equal(createSession.response.status, 201, 'create session should succeed against the live owner service');
    sessionId = createSession.json?.session?.id || '';
    assert.ok(sessionId, 'create session should return a session id');

    const submit = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: {
        requestId: `live-restart-${Date.now()}`,
        text: 'Run the live restart fake tool',
        tool: toolId,
        model: 'fake-model',
        effort: 'low',
      },
    });
    assert.ok([200, 202].includes(submit.response.status), 'submit message should start a run');
    runId = submit.json?.run?.id || '';
    assert.ok(runId, 'submit response should include a run id');

    await waitForRunState(runId, 'running');
    await waitFor(async () => {
      const events = await loadEvents(sessionId).catch(() => null);
      return events?.some((event) => event.type === 'tool_result' && event.output === 'fake-live') ? events : false;
    }, 'incremental tool output before owner restart', 60_000, 500);

    await systemctl(['restart', serviceName]);

    await requestWithRetry('/api/auth/me', {}, 'owner service to recover after restart', 90_000, 1_000);
    const afterPid = (await systemctl(['show', '--property=MainPID', '--value', serviceName])).stdout.trim();
    assert.notEqual(afterPid, beforePid, 'owner service should have a new main PID after restart');

    const finalRun = await waitForRunState(runId, ['completed', 'failed', 'cancelled'], 180_000, 1_000);
    assert.equal(finalRun.state, 'completed', 'detached run should survive a live owner restart');

    const runDir = join(runsDir, runId);
    const persistedStatus = JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8'));
    const persistedResult = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
    assert.equal(persistedStatus.state, 'completed', 'persisted status should converge to completed');
    assert.equal(persistedResult.exitCode, 0, 'persisted result should retain successful exit');
    assert.equal(
      persistedStatus.runnerLaunchMode,
      'systemd-transient-service',
      'live owner restart test expects systemd-backed detached runner launch',
    );
    assert.ok(persistedStatus.runnerUnitName, 'systemd-backed detached runs should persist their transient unit name');
    assert.equal(persistedStatus.runnerUnitScope, 'system', 'live owner runs should be launched in system scope');

    const events = await loadEvents(sessionId);
    const toolResults = events.filter((event) => event.type === 'tool_result' && event.output === 'fake-live');
    assert.equal(toolResults.length, 1, 'incremental tool output should be committed exactly once');

    const assistantMessages = events.filter(
      (event) => event.type === 'message'
        && event.role === 'assistant'
        && event.content === 'finished from live restart fake codex',
    );
    assert.equal(assistantMessages.length, 1, 'final assistant message should be committed exactly once');

    console.log(JSON.stringify({
      ok: true,
      sessionId,
      runId,
      beforePid,
      afterPid,
      runnerUnitName: persistedStatus.runnerUnitName,
      runnerLaunchMode: persistedStatus.runnerLaunchMode,
    }, null, 2));
    console.log('test-live-owner-restart-survival: ok');
  } finally {
    removeLiveFakeTool();
  }
}

await main();
