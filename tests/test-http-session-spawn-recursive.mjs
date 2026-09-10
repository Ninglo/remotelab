#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 38000 + Math.floor(Math.random() * 4000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 20000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function buildFakeCodexScript() {
  return [
    '#!/usr/bin/env node',
    "const { execFile } = require('child_process');",
    "const { promisify } = require('util');",
    'const execFileAsync = promisify(execFile);',
    "const delay = Number(process.env.FAKE_CODEX_DELAY_MS || '120');",
    "const prompt = typeof process.argv[process.argv.length - 1] === 'string' ? process.argv[process.argv.length - 1] : '';",
    "const shouldSpawnThreeChildren = prompt.includes('spawn exactly three parallel sessions') && !prompt.includes('## Delegated task');",
    'let cancelled = false;',
    "process.on('SIGTERM', () => {",
    '  cancelled = true;',
    '  setTimeout(() => process.exit(143), 20);',
    '});',
    'console.log(JSON.stringify({ type: \"thread.started\", thread_id: \"thread-test\" }));',
    'console.log(JSON.stringify({ type: \"turn.started\" }));',
    'function buildSpawnTasks() {',
    '  return [',
    "    'Subtask 1: inspect API delegation path.',",
    "    'Subtask 2: verify prompt handoff stays bounded.',",
    "    'Subtask 3: confirm source session gets visible spawn notes.',",
    '  ];',
    '}',
    'async function spawnChildSessions() {',
    '  const projectRoot = process.env.REMOTELAB_PROJECT_ROOT || process.cwd();',
    "  const baseUrl = process.env.REMOTELAB_CHAT_BASE_URL || `http://127.0.0.1:${process.env.CHAT_PORT || '7690'}`;",
    '  const cliPath = `${projectRoot}/cli.js`;',
    '  const tasks = buildSpawnTasks();',
    '  return Promise.all(tasks.map(async (task) => {',
    '    const result = await execFileAsync(process.execPath, [cliPath, \"session-spawn\", \"--task\", task, \"--base-url\", baseUrl, \"--json\"], {',
    '      cwd: projectRoot,',
    '      env: process.env,',
    '      maxBuffer: 1024 * 1024,',
    '    });',
    '    const parsed = JSON.parse((result.stdout || \"\").trim());',
    '    return { task, sessionId: parsed.sessionId, runId: parsed.runId, state: parsed.state, sessionUrl: parsed.sessionUrl };',
    '  }));',
    '}',
    'setTimeout(() => {',
    '  void (async () => {',
    '    if (cancelled) return;',
    '    try {',
    '      console.log(JSON.stringify({',
    '        type: \"item.completed\",',
    '        item: {',
    '          type: \"command_execution\",',
    "          command: shouldSpawnThreeChildren ? 'remotelab session-spawn x3' : 'echo fake',",
    "          aggregated_output: shouldSpawnThreeChildren ? 'spawned parallel sessions' : 'fake',",
    '          exit_code: 0,',
    '          status: \"completed\",',
    '        },',
    '      }));',
    '      if (shouldSpawnThreeChildren) {',
    '        const children = await spawnChildSessions();',
    '        if (cancelled) return;',
    '        console.log(JSON.stringify({',
    '          type: \"item.completed\",',
    '          item: { type: \"agent_message\", text: `spawned 3 parallel sessions\\n${JSON.stringify(children)}` },',
    '        }));',
    '      } else {',
    '        console.log(JSON.stringify({',
    '          type: \"item.completed\",',
    "          item: { type: \"agent_message\", text: 'finished from fake codex' },",
    '        }));',
    '      }',
    '      console.log(JSON.stringify({',
    '        type: \"turn.completed\",',
    '        usage: { input_tokens: 1, output_tokens: 1 },',
    '      }));',
    '    } catch (error) {',
    '      if (cancelled) return;',
    '      console.log(JSON.stringify({',
    '        type: \"turn.failed\",',
    '        error: { message: error && error.message ? error.message : String(error) },',
    '      }));',
    '    }',
    '  })();',
    '}, delay);',
    '',
  ].join('\n');
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-session-spawn-'));
  const configDir = join(home, '.config', 'remotelab');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
        reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
      },
    ], null, 2),
    'utf8',
  );

  writeFileSync(join(localBin, 'fake-codex'), buildFakeCodexScript(), 'utf8');
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home, configDir, localBin };
}

async function startServer({ home, port, delayMs = 120 }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      CHAT_PORT: String(port),
      REMOTELAB_CHAT_BASE_URL: `http://127.0.0.1:${port}`,
      REMOTELAB_PUBLIC_BASE_URL: 'https://delegation.example',
      SECURE_COOKIES: '0',
      FAKE_CODEX_DELAY_MS: String(delayMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function createSession(port, name) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name,
    group: 'Tests',
    description: 'Recursive spawn integration',
  });
  assert.equal(res.status, 201, 'session creation should succeed');
  return res.json.session;
}

async function patchSessionRuntime(port, sessionId, patch) {
  const res = await request(port, 'PATCH', `/api/sessions/${sessionId}`, patch);
  assert.equal(res.status, 200, 'PATCH should persist runtime preferences');
  return res.json.session;
}

async function submitMessage(port, sessionId, requestId, text) {
  const res = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId,
    text,
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.ok(res.status === 202 || res.status === 200, 'submit should succeed');
  return res;
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    if (!['completed', 'failed', 'cancelled'].includes(res.json.run.state)) return false;
    return res.json.run;
  }, `run ${runId} terminal`);
}

async function listSessions(port) {
  const res = await request(port, 'GET', '/api/sessions');
  assert.equal(res.status, 200, 'session listing should succeed');
  return res.json.sessions || [];
}

async function getEvents(port, sessionId) {
  const res = await request(port, 'GET', `/api/sessions/${sessionId}/events`);
  assert.equal(res.status, 200, 'events request should succeed');
  return res.json.events || [];
}

function readRunManifest(home, runId) {
  return JSON.parse(
    readFileSync(join(home, '.config', 'remotelab', 'chat-runs', runId, 'manifest.json'), 'utf8'),
  );
}

function findLatestAssistantReply(events, runId) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'message' || event.role !== 'assistant') continue;
    if (event.messageKind === 'session_delegate_notice') continue;
    if (runId && event.runId !== runId) continue;
    return event;
  }
  return null;
}

try {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port, delayMs: 1500 });
  let manager = null;
  let managerRunId = '';

  try {
    manager = await createSession(port, 'Recursive spawn manager');
    for (const sourceRunId of [42, 'missing-run']) {
      const invalid = await request(port, 'POST', `/api/sessions/${manager.id}/delegate`, { task: 'Invalid source', sourceRunId });
      assert.equal(invalid.status, 400, 'invalid source run must fail before child admission');
      assert.equal((await listSessions(port)).length, 1, 'invalid source run must not leave a child');
    }
    const patched = await patchSessionRuntime(port, manager.id, {
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
      thinking: false,
    });
    assert.equal(patched.model, 'fake-model', 'manager should keep the cheap fake model pinned');
    assert.equal(patched.effort, 'low', 'manager should keep the cheap fake effort pinned');

    const submit = await submitMessage(
      port,
      manager.id,
      'req-recursive-session-spawn',
      'Manager test: spawn exactly three parallel sessions and keep them independent.',
    );
    managerRunId = submit.json.run.id;
    await patchSessionRuntime(port, manager.id, { model: 'next-turn-model', effort: 'high' });
    const managerRun = await waitForRunTerminal(port, submit.json.run.id);
    assert.equal(managerRun.state, 'completed', 'manager run should complete after spawning children');

    const managerEvents = await waitFor(async () => {
      const events = await getEvents(port, manager.id);
      const operations = events.filter(
        (event) => event.type === 'context_operation' && event.operation === 'delegate_session',
      );
      return operations.length === 3 ? events : false;
    }, 'visible delegation operations on the manager session');
    const delegationOperations = managerEvents.filter(
      (event) => event.type === 'context_operation' && event.operation === 'delegate_session',
    );
    assert.equal(delegationOperations.length, 3, 'manager session should expose one visible delegation operation per spawned child');
    assert.equal(
      delegationOperations.every((event) => event.phase === 'applied' && event.trigger === 'delegation'),
      true,
      'delegation operations should be marked as applied delegation events',
    );
    const delegatedChildIds = delegationOperations
      .map((event) => (typeof event.targetSessionId === 'string' ? event.targetSessionId : ''))
      .filter(Boolean)
      .sort();
    assert.equal(delegatedChildIds.length, 3, 'manager should spawn exactly three parallel sessions');

    const sessions = await waitFor(async () => {
      const listed = await listSessions(port);
      const allDelegatedVisible = delegatedChildIds.every((id) => listed.some((entry) => entry.id === id));
      return allDelegatedVisible ? listed : false;
    }, 'delegated child sessions to become visible');
    const childSessions = delegatedChildIds
      .map((id) => sessions.find((entry) => entry.id === id))
      .filter(Boolean);
    assert.equal(childSessions.length, 3, 'delegated child sessions should all be visible in the session list');

    const managerReply = [...managerEvents].reverse().find(
      (event) => event.type === 'message'
        && event.role === 'assistant'
        && /spawned 3 parallel sessions/.test(event.content || ''),
    );
    assert.ok(managerReply, 'manager run should record a final assistant reply');
    assert.match(managerReply.content || '', /spawned 3 parallel sessions/, 'manager reply should summarize the fan-out');

    const summaryPayload = JSON.parse((managerReply.content || '').split('\n').slice(1).join('\n').trim());
    assert.equal(summaryPayload.length, 3, 'manager reply should list all spawned runs');

    const repliedChildIds = summaryPayload.map((entry) => entry.sessionId).sort();
    assert.deepEqual(repliedChildIds, delegatedChildIds, 'reply summary should match the direct child sessions recorded on the manager');

    for (const childSummary of summaryPayload) {
      assert.equal(typeof childSummary.runId, 'string', 'each spawned session should report its run id');
      assert.match(childSummary.sessionUrl, /^https:\/\/delegation\.example\/\?session=/, 'CLI returns the server public URL');
      assert.ok(['accepted', 'preparing', 'running'].includes(childSummary.state), 'creation reports admission state, not imagined completion');

      const childRun = await waitForRunTerminal(port, childSummary.runId);
      assert.equal(childRun.state, 'completed', 'each spawned session run should complete');

      const manifest = readRunManifest(home, childSummary.runId);
      assert.equal(manifest.options?.model, 'fake-model', 'spawned session runs should inherit the pinned cheap model');
      assert.equal(manifest.options?.effort, 'low', 'spawned session runs should inherit the pinned cheap effort');
      assert.match(manifest.prompt || '', new RegExp(`Parent session id: ${manager.id}`), 'spawned session prompts should receive a minimal parent-session pointer');
      assert.doesNotMatch(manifest.prompt || '', /## Delegated task/, 'spawned session prompts should avoid heavy delegated-task formatting');

      const childDetail = await request(port, 'GET', `/api/sessions/${childSummary.sessionId}`);
      assert.equal(childDetail.status, 200, 'spawned session should be readable');
      assert.equal(childDetail.json.session?.model, 'fake-model', 'spawned session should inherit the pinned model');
      assert.equal(childDetail.json.session?.effort, 'low', 'spawned session should inherit the pinned effort');
      assert.equal(childDetail.json.session?.delegatedFromSessionId, undefined, 'spawned session should stay independent');

      const childEvents = await waitFor(async () => {
        const events = await getEvents(port, childSummary.sessionId);
        return events.some(
          (event) => event.type === 'message'
            && event.role === 'assistant'
            && /finished from fake codex/.test(event.content || ''),
        ) ? events : false;
      }, `visible child reply for ${childSummary.sessionId}`);
      const childReply = [...childEvents].reverse().find(
        (event) => event.type === 'message'
          && event.role === 'assistant'
          && /finished from fake codex/.test(event.content || ''),
      );
      assert.match(childReply?.content || '', /finished from fake codex/, 'spawned session should still execute its own task');
    }

    console.log('test-http-session-spawn-recursive: ok');
  } catch (error) {
    if (manager?.id) {
      try {
        const listed = await listSessions(port);
        console.error('[debug] listed sessions:', JSON.stringify(listed, null, 2));
      } catch {}
      try {
        const events = await getEvents(port, manager.id);
        console.error('[debug] manager events:', JSON.stringify(events, null, 2));
      } catch {}
      if (managerRunId) {
        try {
          const manifest = readRunManifest(home, managerRunId);
          console.error('[debug] manager manifest:', JSON.stringify(manifest, null, 2));
        } catch {}
      }
    }
    console.error('[debug] chat-server stdout:', server.getStdout());
    console.error('[debug] chat-server stderr:', server.getStderr());
    throw error;
  } finally {
    await stopServer(server);
    if (process.env.REMOTELAB_KEEP_TEST_HOME === '1') {
      console.error(`[debug] kept test home at ${home}`);
    } else {
      rmSync(home, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
