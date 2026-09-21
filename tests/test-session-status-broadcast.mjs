#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-status-broadcast-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'finished' },
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}, 25);
setTimeout(() => process.exit(0), 40);
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);

writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify(
    [
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: {
          kind: 'enum',
          label: 'Reasoning',
          levels: ['low'],
          default: 'low',
        },
      },
    ],
    null,
    2,
  ),
  'utf8',
);

setIsolatedTestHome(tempHome);
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const wsClients = await import(
  pathToFileURL(join(repoRoot, 'chat', 'ws-clients.mjs')).href
);

const {
  createSession,
  getRunState,
  killAll,
  submitHttpMessage,
} = sessionManager;
const { setWss } = wsClients;

function makeWs(authSession) {
  return {
    readyState: 1,
    _authSession: authSession,
    messages: [],
    send(payload) {
      this.messages.push(JSON.parse(payload));
    },
  };
}

async function waitFor(predicate, description, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

const alphaWs = makeWs({ personId: 'person_alpha', identityId: 'identity_web_alpha' });
const betaWs = makeWs({ personId: 'person_beta', identityId: 'identity_web_beta' });
setWss({ clients: new Set([alphaWs, betaWs]) });

const alphaSession = await createSession(tempHome, 'fake-codex', 'Alpha task', {
  group: 'Tests',
  description: 'Shared invalidation test A',
});
assert.equal(
  alphaWs.messages.some((msg) => msg.type === 'sessions_invalidated'),
  true,
  'creating a session should invalidate every authenticated session list',
);
assert.equal(betaWs.messages.some((msg) => msg.type === 'sessions_invalidated'), true);
alphaWs.messages = [];
betaWs.messages = [];

await createSession(tempHome, 'fake-codex', 'Shared task B', {
  group: 'Tests',
  description: 'Shared invalidation test B',
});
assert.equal(
  alphaWs.messages.some((msg) => msg.type === 'sessions_invalidated'),
  true,
  'creating another session should also invalidate the shared session list',
);
alphaWs.messages = [];
betaWs.messages = [];

const alphaOutcome = await submitHttpMessage(alphaSession.id, 'Say hello', [], {
  requestId: 'alpha-run',
  tool: 'fake-codex',
  model: 'fake-model',
  effort: 'low',
});

await waitFor(
  () => alphaWs.messages.some(
    (msg) => msg.type === 'session_invalidated' && msg.sessionId === alphaSession.id,
  ),
  'Alpha should receive invalidation for the shared Session',
);

await waitFor(() => {
  return getRunState(alphaOutcome.run.id).then((run) => run && ['completed', 'failed', 'cancelled'].includes(run.state));
}, 'Alpha run should complete');

assert.equal(
  alphaWs.messages.some((msg) => ['session', 'event', 'history'].includes(msg.type)),
  false,
  'websockets should not receive state-bearing payloads',
);

const betaSession = await createSession(tempHome, 'fake-codex', 'Beta task', {
  group: 'Tests',
  description: 'Second Person invalidation test',
});
alphaWs.messages = [];
betaWs.messages = [];

const betaOutcome = await submitHttpMessage(betaSession.id, 'Beta run', [], {
  requestId: 'beta-run',
  tool: 'fake-codex',
  model: 'fake-model',
  effort: 'low',
});

await waitFor(
  () => betaWs.messages.some(
    (msg) => msg.type === 'session_invalidated' && msg.sessionId === betaSession.id,
  ),
  'Beta should receive invalidation for the shared Session',
);

await waitFor(() => {
  return getRunState(betaOutcome.run.id).then((run) => run && ['completed', 'failed', 'cancelled'].includes(run.state));
}, 'Beta run should complete');

assert.equal(
  alphaWs.messages.some(
    (msg) => msg.type === 'session_invalidated' && msg.sessionId === betaSession.id,
  ),
  true,
  'all authenticated clients should receive Session invalidations',
);

assert.equal(
  betaWs.messages.some((msg) => ['session', 'event', 'history'].includes(msg.type)),
  false,
  'Beta websocket should stay invalidation-only',
);

await killAll();
setWss({ clients: new Set() });
rmSync(tempHome, { recursive: true, force: true });

console.log('test-session-status-broadcast: ok');
