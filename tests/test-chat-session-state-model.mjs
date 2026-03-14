#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(
  join(repoRoot, 'static', 'chat', 'session-state-model.js'),
  'utf8',
);

const context = { console };
context.globalThis = context;
context.window = context;

vm.runInNewContext(source, context, {
  filename: 'session-state-model.js',
});

const model = context.RemoteLabSessionStateModel;

assert.ok(model, 'session state model should attach to the global scope');

function makeActivity(overrides = {}) {
  return {
    run: {
      state: 'idle',
      phase: null,
      runId: null,
      cancelRequested: false,
      ...overrides.run,
    },
    queue: {
      state: 'idle',
      count: 0,
      ...overrides.queue,
    },
    rename: {
      state: 'idle',
      error: null,
      ...overrides.rename,
    },
    compact: {
      state: 'idle',
      ...overrides.compact,
    },
  };
}

function makeSession(overrides = {}) {
  return {
    id: 'session-test',
    activity: makeActivity(),
    ...overrides,
  };
}

const runningSession = makeSession({
  activity: makeActivity({
    run: { state: 'running', phase: 'accepted', runId: 'run-1' },
  }),
});
const runningStatus = model.getSessionStatusSummary(runningSession);
assert.equal(runningStatus.primary.key, 'running');
assert.equal(model.isSessionBusy(runningSession), true);

const queuedSession = makeSession({
  activity: makeActivity({
    queue: { state: 'queued', count: 2 },
  }),
});
const queuedStatus = model.getSessionStatusSummary(queuedSession);
assert.equal(queuedStatus.primary.key, 'queued');
assert.equal(queuedStatus.primary.title, '2 follow-ups queued');
assert.equal(model.isSessionBusy(queuedSession), true);

const compactingSession = makeSession({
  activity: makeActivity({
    compact: { state: 'pending' },
  }),
});
assert.equal(model.getSessionStatusSummary(compactingSession).primary.key, 'compacting');
assert.equal(model.isSessionBusy(compactingSession), true);

const renamingSession = makeSession({
  activity: makeActivity({
    rename: { state: 'pending', error: null },
  }),
});
assert.equal(model.getSessionStatusSummary(renamingSession).primary.key, 'renaming');
assert.equal(model.isSessionBusy(renamingSession), false);

const renameFailedSession = makeSession({
  activity: makeActivity({
    rename: { state: 'failed', error: 'rename crashed' },
  }),
});
const renameFailedStatus = model.getSessionStatusSummary(renameFailedSession);
assert.equal(renameFailedStatus.primary.key, 'rename-failed');
assert.equal(renameFailedStatus.primary.title, 'rename crashed');

assert.deepEqual(
  model.getBoardColumns().map((column) => column.key),
  ['parked', 'running', 'waiting_user', 'done'],
  'board columns should stay in the left-to-right workflow order',
);

const parkedBoardColumn = model.getSessionBoardColumn(makeSession());
assert.equal(parkedBoardColumn.key, 'parked');

const waitingBoardColumn = model.getSessionBoardColumn(
  makeSession({ workflowState: 'waiting-user' }),
);
assert.equal(waitingBoardColumn.key, 'waiting_user');

const doneBoardColumn = model.getSessionBoardColumn(
  makeSession({ workflowState: 'done' }),
);
assert.equal(doneBoardColumn.key, 'done');

const runningBoardColumn = model.getSessionBoardColumn(
  makeSession({
    workflowState: 'done',
    activity: makeActivity({
      run: { state: 'running', phase: 'accepted', runId: 'run-2' },
    }),
  }),
);
assert.equal(runningBoardColumn.key, 'running', 'live runtime should override stored workflow state in the board');

const toolFallbackStatus = model.getSessionStatusSummary(
  makeSession({ tool: 'codex' }),
  { includeToolFallback: true },
);
assert.equal(toolFallbackStatus.primary.key, 'tool');
assert.equal(toolFallbackStatus.primary.label, 'codex');

const idleStatus = model.getSessionStatusSummary(makeSession());
assert.equal(idleStatus.primary.key, 'idle');
assert.equal(idleStatus.primary.label, 'idle');

console.log('test-chat-session-state-model: ok');
