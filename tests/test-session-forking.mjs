#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'remotelab-session-fork-'));
process.env.HOME = home;

const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });

const {
  createSession,
  forkSession,
  getHistory,
  getSession,
  killAll,
} = await import('./chat/session-manager.mjs');
const {
  appendEvents,
  getContextHead,
  setContextHead,
} = await import('./chat/history.mjs');

try {
  const parent = await createSession(workspace, 'codex', 'Source session', {
    group: 'Painting',
    description: 'Original discussion to branch from',
    appId: 'app-owner-console',
    systemPrompt: 'Stay focused on the user topic.',
    externalTriggerId: 'email-thread:parent-thread',
    completionTargets: [{
      id: 'email_target_parent',
      type: 'email',
      requestId: 'req_parent_completion',
      to: 'owner@example.com',
      subject: 'Re: source session',
      inReplyTo: '<parent@example.com>',
      references: '<parent@example.com>',
    }],
  });

  await appendEvents(parent.id, [
    {
      type: 'message',
      role: 'user',
      content: 'Let us keep the original conversation intact.',
      requestId: 'req_parent',
      runId: 'run_parent',
      timestamp: 1,
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'Sure. We can split follow-up threads later.',
      requestId: 'req_parent',
      runId: 'run_parent',
      timestamp: 2,
    },
    {
      type: 'tool_use',
      id: 'tool_parent_1',
      toolName: 'shell',
      toolInput: 'echo hello',
      requestId: 'req_parent',
      runId: 'run_parent',
      timestamp: 3,
    },
    {
      type: 'tool_result',
      toolName: 'shell',
      output: 'hello',
      exitCode: 0,
      requestId: 'req_parent',
      runId: 'run_parent',
      timestamp: 4,
    },
    {
      type: 'status',
      content: 'interrupted before follow-up',
      requestId: 'req_parent',
      runId: 'run_parent',
      timestamp: 5,
    },
  ]);

  await setContextHead(parent.id, {
    mode: 'summary',
    summary: 'The original conversation is summarized here.',
    activeFromSeq: 2,
    compactedThroughSeq: 2,
    inputTokens: 321,
    updatedAt: '2026-03-10T00:00:00.000Z',
    source: 'manual',
  });

  const sessionsPath = join(home, '.config', 'remotelab', 'chat-sessions.json');
  const storedSessions = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  const parentRecord = storedSessions.find((entry) => entry.id === parent.id);
  assert.ok(parentRecord, 'parent session record should exist');
  parentRecord.codexThreadId = 'codex-parent-thread';
  parentRecord.claudeSessionId = 'claude-parent-thread';
  parentRecord.activeRun = {
    id: 'interrupted-parent-run',
    tool: 'codex',
    model: 'fake-model',
    thinking: false,
  };
  writeFileSync(sessionsPath, JSON.stringify(storedSessions, null, 2), 'utf8');

  const child = await forkSession(parent.id);
  assert.ok(child, 'fork should create a child session');
  assert.notEqual(child.id, parent.id, 'fork should create a new session id');
  assert.equal(child.name, 'fork - Source session', 'fork should keep the fixed name prefix');
  assert.equal(child.group, parent.group, 'fork should copy the session group');
  assert.equal(child.description, parent.description, 'fork should copy the session description');
  assert.equal(child.folder, parent.folder, 'fork should keep the same folder');
  assert.equal(child.tool, parent.tool, 'fork should keep the same tool');
  assert.equal(child.appId, parent.appId, 'fork should keep the same app scope');
  assert.equal(child.systemPrompt, parent.systemPrompt, 'fork should keep the same prompt');
  assert.equal(child.forkedFromSessionId, parent.id, 'fork should record the parent id');
  assert.equal(child.rootSessionId, parent.id, 'first fork should use parent as root');
  assert.equal(child.forkedFromSeq, 5, 'fork should record the copied sequence boundary');
  assert.equal(typeof child.forkedAt, 'string', 'fork should record forkedAt');
  assert.equal(child.activeRunId, undefined, 'fork should not keep activeRunId');
  assert.equal(child.activeRun, undefined, 'fork should not keep interrupted run state');
  assert.equal(child.codexThreadId, undefined, 'fork should clear Codex resume ids');
  assert.equal(child.claudeSessionId, undefined, 'fork should clear Claude resume ids');
  assert.equal(child.externalTriggerId, undefined, 'fork should clear external trigger ids');
  assert.equal(child.completionTargets, undefined, 'fork should not inherit completion targets');
  assert.equal(child.status, 'idle', 'forked child should start idle');
  assert.equal(child.latestSeq, 5, 'forked child should keep the copied history length');

  const parentLoaded = await getSession(parent.id);
  assert.equal(parentLoaded?.codexThreadId, 'codex-parent-thread', 'fork should not mutate the parent resume id');
  assert.equal(parentLoaded?.claudeSessionId, 'claude-parent-thread', 'fork should not mutate the parent Claude id');
  assert.equal(parentLoaded?.externalTriggerId, 'email-thread:parent-thread', 'fork should not mutate the parent external trigger id');
  assert.equal(parentLoaded?.completionTargets?.length, 1, 'fork should not mutate the parent completion targets');
  assert.equal(parentLoaded?.activeRun?.id, 'interrupted-parent-run', 'fork should not mutate the parent interrupted run metadata');

  const parentHistory = await getHistory(parent.id);
  const childHistory = await getHistory(child.id);
  assert.equal(childHistory.length, parentHistory.length, 'fork should copy the full normalized history');
  assert.deepEqual(
    childHistory.map((event) => event.type),
    parentHistory.map((event) => event.type),
    'fork should preserve event ordering',
  );
  assert.equal(
    childHistory.some((event) => Object.prototype.hasOwnProperty.call(event, 'runId')),
    false,
    'forked history should strip parent run ids',
  );
  assert.equal(
    childHistory.some((event) => Object.prototype.hasOwnProperty.call(event, 'requestId')),
    false,
    'forked history should strip parent request ids',
  );
  assert.equal(childHistory[0].content, parentHistory[0].content, 'fork should preserve message content');
  assert.equal(childHistory[2].toolInput, 'echo hello', 'fork should preserve tool input bodies');
  assert.equal(childHistory[3].output, 'hello', 'fork should preserve tool result bodies');

  const parentContext = await getContextHead(parent.id);
  const childContext = await getContextHead(child.id);
  assert.deepEqual(childContext, parentContext, 'fork should copy the current context head');

  console.log('test-session-forking: ok');
} finally {
  killAll();
  rmSync(home, { recursive: true, force: true });
}
