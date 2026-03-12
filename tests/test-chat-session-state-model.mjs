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

const context = {
  console,
};
context.globalThis = context;
context.window = context;

vm.runInNewContext(source, context, {
  filename: 'session-state-model.js',
});

const model = context.RemoteLabSessionStateModel;

assert.ok(model, 'session state model should attach to the global scope');

const runningWithIssue = model.getSessionStatusSummary(
  {
    id: 'session-running',
    name: 'Running session',
    status: 'running',
  },
  {
    hasSendFailure: true,
  },
);
assert.equal(runningWithIssue.primary.key, 'running');
assert.equal(
  Array.from(runningWithIssue.indicators, (indicator) => indicator.key).join(','),
  'running,send-failed',
  'running should remain the primary state while a local send issue is secondary',
);

const idleWithIssue = model.getSessionStatusSummary(
  {
    id: 'session-idle',
    name: 'Idle session',
    status: 'idle',
  },
  {
    hasSendFailure: true,
  },
);
assert.equal(idleWithIssue.primary.key, 'send-failed');
assert.equal(idleWithIssue.primary.label, 'send issue');

const pendingAccepted = model.normalizePendingMessage({
  text: 'hello',
  requestId: 'req-1',
  timestamp: 1,
  deliveryState: 'accepted',
});
assert.equal(
  model.shouldKeepPendingMessagePending(pendingAccepted, { status: 'running' }),
  true,
  'accepted pending messages should stay non-failing while the session is busy',
);

const pendingSending = model.normalizePendingMessage({
  text: 'hello',
  requestId: 'req-2',
  timestamp: 2,
});
assert.equal(
  model.shouldKeepPendingMessagePending(pendingSending, { status: 'idle' }),
  false,
  'legacy pending messages should surface for recovery once the session is no longer busy',
);

const doneUnread = model.getSessionStatusSummary(
  {
    id: 'session-done',
    status: 'done',
  },
  {
    isRead: () => false,
  },
);
assert.equal(doneUnread.primary.key, 'done-unread');
