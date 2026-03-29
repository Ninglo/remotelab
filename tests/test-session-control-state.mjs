#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildManagerMemorySearchPolicy,
  buildPreparedContinuationPromptFromWorkState,
  buildSessionControlState,
  buildSessionWorkState,
} from '../chat/session-control-state.mjs';

const promptContext = {
  scopeRouter: 'Matched scope router entry: remotelab',
  relatedSessions: 'Related session: prompt-layer cleanup',
};

const controlState = buildSessionControlState({
  activeAgreements: [
    '默认自然段表达。',
    '默认自然段表达。',
    '先统一对象边界，再讨论后续自动提升。',
  ],
  taskCard: {
    mode: 'project',
    summary: '先把 carrier 收到一层后端对象投影。',
    reusablePatterns: ['先收敛状态对象，再讨论自动提升与记忆。'],
    nextSteps: ['整理载体映射', '接 prompt 投影'],
  },
  workflowState: 'waiting-user',
  workflowPriority: 'urgent',
  entryMode: 'read',
  lastReviewedAt: '2026-03-14T12:00:00.000Z',
}, {
  promptContext,
  memorySearchPolicy: buildManagerMemorySearchPolicy(promptContext),
});

assert.deepEqual(
  controlState.managerState.activeAgreements,
  ['默认自然段表达。', '先统一对象边界，再讨论后续自动提升。'],
  'managerState should normalize and dedupe active agreements',
);
assert.equal(
  controlState.managerState.memoryActivation.scopeRouter,
  promptContext.scopeRouter,
  'managerState should carry prompt-time scope-router activation',
);
assert.equal(
  controlState.managerState.memoryActivation.relatedSessions,
  promptContext.relatedSessions,
  'managerState should carry related-session activation',
);
assert.match(
  controlState.managerState.memoryActivation.searchPolicy,
  /Prefer carried context, matched scope-router hints/
);

assert.equal(controlState.workState.workflow.entryMode, 'read');
assert.equal(controlState.workState.workflow.state, 'waiting_user');
assert.equal(controlState.workState.workflow.priority, 'high');
assert.equal(controlState.workState.taskCard.summary, '先把 carrier 收到一层后端对象投影。');
assert.deepEqual(controlState.workState.taskCard.reusablePatterns, ['先收敛状态对象，再讨论自动提升与记忆。']);

const workState = buildSessionWorkState({}, {
  contextHead: {
    mode: 'summary',
    summary: '当前已经做完 Phase 1 文档和第一轮代码收口。',
    activeFromSeq: 18,
    toolIndex: 'tool-call-1\ntool-call-2',
  },
  forkContext: {
    mode: 'summary',
    summary: '已存在会话总结。',
    continuationBody: '[User]\n继续推进。',
    preparedThroughSeq: 22,
    updatedAt: '2026-03-14T13:00:00.000Z',
  },
});

assert.equal(workState.continuation.head.activeFromSeq, 18);
assert.equal(workState.continuation.prepared.preparedThroughSeq, 22);

const continuationPrompt = buildPreparedContinuationPromptFromWorkState(workState, 'codex', 'codex');
assert.match(continuationPrompt, /\[Conversation summary\]/);
assert.match(continuationPrompt, /已存在会话总结/);
assert.match(continuationPrompt, /Treat it as the authoritative context/);
assert.match(continuationPrompt, /Earlier tool activity index/);
assert.match(continuationPrompt, /tool-call-1/);

console.log('test-session-control-state: ok');
