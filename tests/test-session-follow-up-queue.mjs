#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const home = mkdtempSync(join(tmpdir(), 'remotelab-follow-up-queue-'));
const configDir = join(home, '.config', 'remotelab');
const binDir = join(home, '.local', 'bin');
const fakeCodexPath = join(binDir, 'fake-codex');

mkdirSync(configDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const delay = Number(process.env.FAKE_CODEX_DELAY_MS || '120');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'reply from fake codex' },
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}, delay);
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

process.env.HOME = home;
process.env.PATH = `${binDir}:${process.env.PATH}`;
process.env.FAKE_CODEX_DELAY_MS = '120';
process.env.REMOTELAB_SESSION_DISPATCH = 'off';

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  getHistory,
  getRunState,
  getSession,
  killAll,
  listSessions,
  submitHttpMessage,
} = sessionManager;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeRm(target, attempts = 6, delayMs = 120) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY') {
        throw error;
      }
      await sleep(delayMs * (i + 1));
    }
  }
  rmSync(target, { recursive: true, force: true });
}

async function waitFor(predicate, description, timeoutMs = 8000, intervalMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const session = await createSession(home, 'fake-codex', 'Follow-up queue test', {
    group: 'Tests',
    description: 'Verifies busy-session follow-up queue flushing',
  });

  const initialOutcome = await submitHttpMessage(session.id, 'First run', [], {
    requestId: 'req-first-run',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  assert.ok(initialOutcome.run?.id, 'initial run should start immediately');

  await waitFor(
    async () => (await getSession(session.id))?.activity?.run?.state === 'running',
    'initial run should enter running state',
  );

  const queuedFirst = await submitHttpMessage(session.id, 'Follow-up one', [], {
    requestId: 'req-follow-1',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.equal(queuedFirst.queued, true, 'follow-up should queue while the current run is active');
  assert.equal(queuedFirst.run, null, 'queued follow-up should not create a new run yet');

  const duplicateWhileQueued = await submitHttpMessage(session.id, 'Duplicate follow-up one', [], {
    requestId: 'req-follow-1',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.equal(duplicateWhileQueued.duplicate, true, 'queued follow-up request ids should dedupe');
  assert.equal(duplicateWhileQueued.queued, true, 'duplicate queued follow-up should report queued state');

  const queuedSecond = await submitHttpMessage(session.id, 'Actually prioritize the second follow-up', [], {
    requestId: 'req-follow-2',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.equal(queuedSecond.queued, true, 'multiple follow-ups should continue to queue');

  const queuedSession = await getSession(session.id, { includeQueuedMessages: true });
  assert.equal(queuedSession?.activity?.queue?.count, 2, 'session detail should expose queued follow-up count');
  assert.equal(queuedSession?.queuedMessages?.length, 2, 'session detail should expose queued follow-up bodies');
  assert.equal(queuedSession?.queuedMessages?.[0]?.text, 'Follow-up one');
  assert.equal(
    (await listSessions()).find((entry) => entry.id === session.id)?.activity?.queue?.count,
    2,
    'session list should expose queued follow-up count',
  );

  await waitFor(
    async () => {
      const current = await getSession(session.id);
      const history = await getHistory(session.id);
      const messageEvents = history.filter((event) => event.type === 'message');
      return current?.activity?.run?.state === 'idle'
        && current?.activity?.queue?.count === 0
        && messageEvents.length >= 4;
    },
    'queued follow-ups should auto-flush into the next turn',
    12000,
  );

  const history = await getHistory(session.id);
  const userMessages = history.filter((event) => event.type === 'message' && event.role === 'user');
  assert.equal(userMessages.length, 2, 'queued follow-ups should become one consolidated user turn');
  assert.equal(userMessages[0].content, 'First run');
  assert.match(userMessages[1].content, /Queued follow-up messages sent while RemoteLab was busy:/);
  assert.match(userMessages[1].content, /Follow-up one/);
  assert.match(userMessages[1].content, /Actually prioritize the second follow-up/);

  const drainedSession = await getSession(session.id, { includeQueuedMessages: true });
  assert.equal(drainedSession?.activity?.queue?.count, 0, 'queue should clear after the next run is accepted');
  assert.deepEqual(drainedSession?.queuedMessages, [], 'drained session should expose an empty queue');

  const duplicateAfterFlush = await submitHttpMessage(session.id, 'Late retry after flush', [], {
    requestId: 'req-follow-1',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.equal(duplicateAfterFlush.duplicate, true, 'recent flushed follow-up ids should still dedupe');
  assert.equal(duplicateAfterFlush.queued, false, 'post-flush duplicate should no longer be pending in the queue');
  assert.equal(duplicateAfterFlush.run, null, 'duplicate retry should not create another run');

  await waitFor(
    () => getRunState(initialOutcome.run.id).then((run) => run && ['completed', 'failed', 'cancelled'].includes(run.state)),
    'initial run should reach a terminal state',
  );

  console.log('test-session-follow-up-queue: ok');
} finally {
  killAll();
  await sleep(250);
  await safeRm(home);
}
