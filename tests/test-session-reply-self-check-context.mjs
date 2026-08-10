#!/usr/bin/env node
import assert from 'assert/strict';

import { messageEvent } from '../chat/normalizer.mjs';
import {
  buildReplySelfCheckPrompt,
  buildReplySelfRepairPrompt,
  extractReplySelfCheckCheckpointPolicy,
  loadReplySelfCheckTurnContext,
} from '../chat/session-reply-self-check.mjs';

const history = [
  {
    ...messageEvent('user', '先把导出的文件发给我。'),
    seq: 1,
    runId: 'run-1',
  },
  {
    ...messageEvent('assistant', '文件已经发出。', [{
      originalName: 'report.csv',
      savedPath: '/tmp/remotelab/report.csv',
      mimeType: 'text/csv',
    }]),
    seq: 2,
    runId: 'run-1',
  },
  {
    ...messageEvent('user', '如果你刚才已经发过文件，这次只要告诉我是不是已经完成。'),
    seq: 3,
    runId: 'run-2',
  },
  {
    ...messageEvent('assistant', '已经完成，文件在上一轮里发过了。'),
    seq: 4,
    runId: 'run-2',
  },
  {
    ...messageEvent('assistant', 'Generated file ready to download.', [{
      assetId: 'asset-proof',
      originalName: 'proof.csv',
      mimeType: 'text/csv',
    }], {
      source: 'result_file_assets',
      resultRunId: 'run-2',
    }),
    seq: 5,
  },
];

const context = await loadReplySelfCheckTurnContext('session-test', 'run-2', {
  loadSessionHistory: async () => history,
});

assert.equal(
  context.userMessage?.content,
  '如果你刚才已经发过文件，这次只要告诉我是不是已经完成。',
  'self-check should still target the current user message',
);
assert.match(
  context.assistantTurnText,
  /已经完成，文件在上一轮里发过了。/,
  'self-check should still include the latest displayed assistant text',
);
assert.match(
  context.assistantTurnText,
  /Generated file ready to download\./,
  'self-check should include result-file delivery copy linked by resultRunId',
);
assert.match(
  context.assistantTurnText,
  /\[Displayed attachment delivery: proof\.csv\]/,
  'self-check should include displayed result-file attachments linked by resultRunId',
);
assert.match(
  context.priorContextText || '',
  /\[Attached files: report\.csv -> \/tmp\/remotelab\/report\.csv\]/,
  'self-check context should include earlier delivered files before the current turn',
);

const reviewPrompt = buildReplySelfCheckPrompt(context);
assert.match(
  reviewPrompt,
  /Relevant earlier session context before this turn:/,
  'review prompt should expose earlier session context when it exists',
);
assert.match(
  reviewPrompt,
  /report\.csv -> \/tmp\/remotelab\/report\.csv/,
  'review prompt should carry earlier delivered file references',
);
assert.match(
  reviewPrompt,
  /已经完成，文件在上一轮里发过了。/,
  'review prompt should still include the latest assistant reply under review',
);
assert.match(
  reviewPrompt,
  /Displayed attachment delivery: proof\.csv/,
  'review prompt should carry current-turn generated file delivery context',
);
assert.match(
  reviewPrompt,
  /A concrete review gate is also a real user checkpoint/,
  'review prompt should distinguish concrete approval gates from generic permission requests',
);
assert.match(
  reviewPrompt,
  /The confirmation round trip may itself be the behavior being tested/,
  'review prompt should preserve interaction-flow tests instead of optimizing away their gates',
);

const checkpointPolicyText = extractReplySelfCheckCheckpointPolicy([
  'S1: inspect the provided brief.',
  'GATE A — BRIEF_CONFIRM: present the proposed search contract and wait for explicit user confirmation.',
  'After confirmation, run the sample search.',
  'Unrelated implementation detail.',
].join('\n'));
assert.match(checkpointPolicyText, /GATE A — BRIEF_CONFIRM/);
assert.match(checkpointPolicyText, /After confirmation/);
assert.doesNotMatch(checkpointPolicyText, /Unrelated implementation detail/);

const checkpointReviewPrompt = buildReplySelfCheckPrompt({
  ...context,
  checkpointPolicyText,
});
assert.match(checkpointReviewPrompt, /Applied Agent review-gate policy:/);
assert.match(checkpointReviewPrompt, /GATE A — BRIEF_CONFIRM/);

const repairPrompt = buildReplySelfRepairPrompt({
  ...context,
  reviewDecision: {
    reason: '上一条答复依赖了先前已经发出的文件。',
    continuationPrompt: '基于已有文件交付事实，直接补上缺的结论，不要重复发文件。',
  },
});
assert.match(
  repairPrompt,
  /Relevant earlier session context before this turn:/,
  'repair prompt should also inherit earlier session context',
);
assert.match(
  repairPrompt,
  /report\.csv -> \/tmp\/remotelab\/report\.csv/,
  'repair prompt should preserve earlier delivered file references',
);

console.log('test-session-reply-self-check-context: ok');
