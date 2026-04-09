#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 34000 + Math.floor(Math.random() * 8000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 100) {
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
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-template-'));
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
  writeFileSync(
    join(localBin, 'fake-codex'),
    `#!/usr/bin/env node
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'echo fake', aggregated_output: 'fake', exit_code: 0, status: 'completed' }
  }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'finished from fake codex' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 120);
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 'server shutdown');
}

async function createSession(port, name) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name,
    group: 'Templates',
  });
  assert.equal(res.status, 201);
  return res.json.session;
}

async function createApp(port, payload = {}) {
  const res = await request(port, 'POST', '/api/agents', payload);
  assert.equal(res.status, 201);
  return res.json;
}

async function submitMessage(port, sessionId, requestId, text) {
  const res = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId,
    text,
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.ok(res.status === 202 || res.status === 200);
  return res.json.run;
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    return ['completed', 'failed', 'cancelled'].includes(res.json.run.state) ? res.json.run : false;
  }, `run ${runId} terminal`);
}

try {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const source = await createSession(port, 'Template source');
    const run = await submitMessage(port, source.id, 'req-source-template', 'Generate the reusable template context');
    await waitForRunTerminal(port, run.id);
    await waitFor(async () => {
      const detail = await request(port, 'GET', `/api/sessions/${source.id}`);
      if (detail.status !== 200) return false;
      return Number(detail.json.session?.messageCount || 0) >= 2
        && detail.json.session?.activity?.run?.state !== 'running';
    }, 'source session history sync');

    const saved = await request(port, 'POST', `/api/sessions/${source.id}/save-template`, {
      name: 'Saved via HTTP',
    });
    assert.equal(saved.status, 201, 'save-template route should create a template');
    assert.ok(saved.json.template?.id, 'save-template route should return the created template');

    const createdWithTemplate = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Template from web source',
      sourceId: 'chat',
      sourceName: 'RemoteLab',
      templateId: saved.json.template.id,
      templateName: saved.json.template.name,
    });
    assert.equal(createdWithTemplate.status, 201, 'session create should support source + template together');
    assert.equal(createdWithTemplate.json.session?.sourceId, 'chat', 'creating with a template should keep the requested source id');
    assert.equal(createdWithTemplate.json.session?.sourceName, 'RemoteLab', 'creating with a template should keep the requested source name');
    assert.equal(createdWithTemplate.json.session?.templateId, saved.json.template.id, 'creating with a template should also persist the template id');

    const target = await createSession(port, 'Template target');
    const applied = await request(port, 'POST', `/api/sessions/${target.id}/apply-template`, {
      templateId: saved.json.template.id,
    });
    assert.equal(applied.status, 200, 'apply-template route should update the target session');
    assert.equal(applied.json.session?.templateId, saved.json.template.id, 'applied session should record the applied template');

    const events = await request(port, 'GET', `/api/sessions/${target.id}/events?filter=all`);
    const templateEvent = (events.json.events || []).find((event) => event.type === 'template_context');
    assert.ok(templateEvent, 'applying a template should append a hidden template event');
    assert.equal(templateEvent.templateFreshness, 'current', 'fresh template application should expose freshness metadata');

    const body = await request(port, 'GET', `/api/sessions/${target.id}/events/${templateEvent.seq}/body`);
    assert.equal(body.status, 200, 'template event body should be readable on demand');
    assert.match(body.json.body.value, /Generate the reusable template context/, 'saved template content should carry source session context');
    assert.match(body.json.body.value, /echo fake/, 'saved template content should preserve source tool work');

    await sleep(20);
    const renamed = await request(port, 'PATCH', `/api/sessions/${source.id}`, {
      name: 'Template source refreshed',
    });
    assert.equal(renamed.status, 200, 'source session rename should update the freshness baseline');

    const staleTarget = await createSession(port, 'Template stale target');
    const staleApplied = await request(port, 'POST', `/api/sessions/${staleTarget.id}/apply-template`, {
      templateId: saved.json.template.id,
    });
    assert.equal(staleApplied.status, 200, 'stale template should still apply');

    const staleEvents = await request(port, 'GET', `/api/sessions/${staleTarget.id}/events?filter=all`);
    const staleTemplateEvent = (staleEvents.json.events || []).find((event) => event.type === 'template_context');
    assert.ok(staleTemplateEvent, 'stale template apply should append a template event');
    assert.equal(staleTemplateEvent.templateFreshness, 'stale', 'stale template application should surface freshness drift');

    const agent = await createApp(port, {
      name: 'HTTP Agent',
      systemPrompt: 'Stay inside the HTTP-created agent.',
      welcomeMessage: 'Welcome from the HTTP agent.',
      tool: 'fake-codex',
    });
    const createdFromTemplate = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Created from template id',
      templateId: agent.id,
    });
    assert.equal(createdFromTemplate.status, 201, 'creating a session with templateId should succeed');
    assert.equal(createdFromTemplate.json.session?.templateId, agent.id, 'session creation should keep the applied agent id');
    assert.equal(createdFromTemplate.json.session?.sourceId, 'chat', 'session creation should keep the canonical web source when applying an agent');
    assert.equal(createdFromTemplate.json.session?.systemPrompt, 'Stay inside the HTTP-created agent.', 'session creation should apply the agent prompt immediately');

    const createdFromTemplateEvents = await request(port, 'GET', `/api/sessions/${createdFromTemplate.json.session.id}/events?filter=all`);
    const welcomeEvent = (createdFromTemplateEvents.json.events || []).find((event) => event.type === 'message' && event.role === 'assistant');
    assert.ok(welcomeEvent, 'creating a session from an agent should append the agent welcome message');
    assert.match(welcomeEvent.content || '', /Welcome from the HTTP agent\./);

    const createdFromStarterPreset = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Create Agent',
      starterPreset: 'create_agent',
    });
    assert.equal(createdFromStarterPreset.status, 201, 'creating a session from a starter preset should succeed');
    assert.equal(createdFromStarterPreset.json.session?.templateId, undefined, 'starter presets should not depend on a built-in agent id');
    assert.match(
      createdFromStarterPreset.json.session?.systemPrompt || '',
      /POST \/api\/agents|PATCH \/api\/agents/i,
      'starter preset sessions should materialize their behavior instructions directly',
    );

    const starterPresetEvents = await request(port, 'GET', `/api/sessions/${createdFromStarterPreset.json.session.id}/events?filter=all`);
    const starterWelcomeEvent = (starterPresetEvents.json.events || []).find((event) => event.type === 'message' && event.role === 'assistant');
    assert.ok(starterWelcomeEvent, 'starter preset sessions should append their opening assistant message');
    assert.match(starterWelcomeEvent.content || '', /SOP|工作流|RemoteLab Agent/i);

    console.log('test-http-session-templates: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
