#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = mkdtempSync(join(tmpdir(), 'remotelab-control-state-'));
setIsolatedTestHome(home);

const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });

const { createSession, getSession, killAll } = await import('./chat/session-manager.mjs');
const { setContextHead, setForkContext } = await import('./chat/history.mjs');
const { mutateSessionMeta } = await import('./chat/session-meta-store.mjs');

try {
  const created = await createSession(workspace, 'codex', 'Control state test', {
    activeAgreements: ['默认自然段表达。', '默认自然段表达。'],
    workflowState: 'waiting_user',
    workflowPriority: 'medium',
  });

  await mutateSessionMeta(created.id, (draft) => {
    draft.workSummary = {
      mode: 'project',
      summary: '先把 manager/work-state 投影接起来。',
      nextSteps: ['补投影层', '补回归测试'],
    };
    draft.updatedAt = '2026-03-14T13:00:00.000Z';
    return true;
  });

  await setContextHead(created.id, {
    mode: 'summary',
    summary: '已有上下文头摘要。',
    activeFromSeq: 5,
    toolIndex: 'shell\napply_patch',
    updatedAt: '2026-03-14T13:10:00.000Z',
    source: 'compaction',
  });

  await setForkContext(created.id, {
    mode: 'summary',
    summary: '已有 prepared continuation。',
    continuationBody: '[User]\n继续推进收口。',
    preparedThroughSeq: 8,
    updatedAt: '2026-03-14T13:20:00.000Z',
    source: 'history',
  });

  const loaded = await getSession(created.id);
  assert.deepEqual(loaded.managerState.activeAgreements, ['默认自然段表达。']);
  assert.equal(loaded.workState.summary.summary, '先把 manager/work-state 投影接起来。');
  assert.equal(loaded.workState.workflow.entryMode, 'resume');
  assert.equal(loaded.workState.workflow.state, 'waiting_user');
  assert.equal(loaded.workState.workflow.priority, 'medium');

  const sessionsPath = join(home, '.config', 'remotelab', 'chat-sessions.json');
  const storedSessions = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  const storedRecord = storedSessions.find((entry) => entry.id === created.id);
  assert.ok(storedRecord, 'stored session meta should exist');
  assert.equal(Object.prototype.hasOwnProperty.call(storedRecord, 'managerState'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(storedRecord, 'workState'), false);

  console.log('test-session-manager-control-state: ok');
} finally {
  await killAll();
  rmSync(home, { recursive: true, force: true });
}
