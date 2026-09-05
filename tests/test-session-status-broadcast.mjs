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
  dropToolUse,
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

const ownerWs = makeWs({ role: 'owner' });
const visitorWs = makeWs({ role: 'visitor', sessionId: 'placeholder' });
setWss({ clients: new Set([ownerWs, visitorWs]) });

const ownerSessionA = await createSession(tempHome, 'fake-codex', 'Owner A', {
  group: 'Tests',
  description: 'Owner invalidation test A',
});
assert.equal(
  ownerWs.messages.some((msg) => msg.type === 'sessions_invalidated'),
  true,
  'creating an owner session should invalidate the owner session list',
);
ownerWs.messages = [];

await createSession(tempHome, 'fake-codex', 'Owner B', {
  group: 'Tests',
  description: 'Owner invalidation test B',
});
assert.equal(
  ownerWs.messages.some((msg) => msg.type === 'sessions_invalidated'),
  true,
  'creating another owner session should also invalidate the owner session list',
);
ownerWs.messages = [];

const ownerOutcome = await submitHttpMessage(ownerSessionA.id, 'Say hello', [], {
  requestId: 'owner-run',
  tool: 'fake-codex',
  model: 'fake-model',
  effort: 'low',
});

await waitFor(
  () => ownerWs.messages.some(
    (msg) => msg.type === 'session_invalidated' && msg.sessionId === ownerSessionA.id,
  ),
  'owner should receive invalidation for its session',
);

await waitFor(() => {
  return getRunState(ownerOutcome.run.id).then((run) => run && ['completed', 'failed', 'cancelled'].includes(run.state));
}, 'owner run should complete');

assert.equal(
  ownerWs.messages.some((msg) => ['session', 'event', 'history'].includes(msg.type)),
  false,
  'owner websocket should not receive state-bearing payloads',
);

ownerWs.messages = [];
const dropResult = await dropToolUse(ownerSessionA.id);
assert.equal(dropResult, true, 'drop tool use should succeed for owner session');
assert.equal(
  ownerWs.messages.some(
    (msg) => msg.type === 'session_invalidated' && msg.sessionId === ownerSessionA.id,
  ),
  true,
  'drop tool use should still invalidate the affected session',
);
assert.equal(
  ownerWs.messages.some((msg) => msg.type === 'sessions_invalidated'),
  false,
  'drop tool use should not invalidate the whole owner session list',
);

const visitorSession = await createSession(tempHome, 'fake-codex', 'Visitor A', {
  visitorId: 'visitor-1',
  group: 'Tests',
  description: 'Visitor invalidation test',
});
visitorWs._authSession.sessionId = visitorSession.id;
ownerWs.messages = [];
visitorWs.messages = [];

const visitorOutcome = await submitHttpMessage(visitorSession.id, 'Visitor run', [], {
  requestId: 'visitor-run',
  tool: 'fake-codex',
  model: 'fake-model',
  effort: 'low',
});

await waitFor(
  () => visitorWs.messages.some(
    (msg) => msg.type === 'session_invalidated' && msg.sessionId === visitorSession.id,
  ),
  'visitor should receive invalidation for its own session',
);

await waitFor(() => {
  return getRunState(visitorOutcome.run.id).then((run) => run && ['completed', 'failed', 'cancelled'].includes(run.state));
}, 'visitor run should complete');

assert.equal(
  ownerWs.messages.some(
    (msg) => msg.type === 'session_invalidated' && msg.sessionId === visitorSession.id,
  ),
  true,
  'owner clients should receive visitor session invalidations for unified session views',
);

assert.equal(
  visitorWs.messages.some((msg) => ['session', 'event', 'history'].includes(msg.type)),
  false,
  'visitor websocket should stay invalidation-only',
);

killAll();
setWss({ clients: new Set() });
rmSync(tempHome, { recursive: true, force: true });

console.log('test-session-status-broadcast: ok');
