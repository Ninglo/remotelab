#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-reply-self-check-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('fs');
const { dirname, join } = require('path');
const prompt = process.argv[process.argv.length - 1] || '';
const isWorkflowPrompt = prompt.includes('You are updating RemoteLab workflow state for a developer session');
const isReplyReviewPrompt = prompt.includes("You are RemoteLab's hidden end-of-turn completion reviewer.");
const isRepairPrompt = prompt.includes('You are continuing the same user-facing reply after a hidden self-check found an avoidable early stop.');
const prefersContinuationWithoutExplicitBlocker = prompt.includes('no explicit user-side blocker');
const flagsAnalysisWithoutExecution = prompt.includes('stopping after analysis when execution was still possible');
const hasBranchFirstRule = prompt.includes('real logical fork or forced human checkpoint');
const prefersDoingWork = prompt.includes('Prefer doing the work over describing what you would do.');
const hasOpenOfferHardRule = prompt.includes('A reply that ends with an open offer or permission request');
const replacesOpenOfferWithResult = prompt.includes('Replace any prior open offer or permission request with the actual next action or result now.');
const avoidsFakeChoiceRepair = prompt.includes('Do not turn a single-track task into a menu of options');
const isDelayedReviewScenario = prompt.includes('延迟复核场景');
const isDelayedAssetReviewScenario = prompt.includes('延迟附件复核场景');
const outputDelayMs = isReplyReviewPrompt
  ? (isDelayedAssetReviewScenario ? 700 : (isDelayedReviewScenario ? 450 : 0))
  : 0;

function writeGeneratedResultAsset(relativePath, content = 'fake generated video') {
  const fullPath = join(process.cwd(), relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

let threadId = 'main-thread';
let items = [{ type: 'agent_message', text: '我已经分析了机制问题。下一条我可以直接给你那份极短执行守则。' }];

if (prompt.includes('开放式邀约场景')) {
  items = [{ type: 'agent_message', text: '我已经整理好了，如果你愿意我现在就把最终结论直接发出来。' }];
}

if (prompt.includes('伪分叉场景')) {
  items = [{ type: 'agent_message', text: '我先停一下，这里好像有几个方向，你选一个我再继续。' }];
}

if (isWorkflowPrompt) {
  threadId = 'workflow-thread';
  items = [{
    type: 'agent_message',
    text: JSON.stringify({ workflowState: 'done', workflowPriority: 'low', reason: 'done' }),
  }];
} else if (isReplyReviewPrompt) {
  threadId = 'review-thread';
  const isChecklistScenario = prompt.includes('todo checklist');
  const isExplicitBlockerScenario = prompt.includes('危险删除场景')
    || prompt.includes('延迟复核场景')
    || prompt.includes('延迟附件复核场景');
  const isOpenOfferScenario = prompt.includes('如果你愿意我现在就把最终结论直接发出来');
  const isPseudoForkScenario = prompt.includes('你选一个我再继续');
  const hasVisibleAnswer = prompt.includes('真正有效答复：把缺的结论直接补齐。');
  const hasDisplayedChecklist = prompt.includes('[ ] todo checklist');
  items = [{
    type: 'agent_message',
    text: '<hide>' + JSON.stringify(isChecklistScenario
      ? {
        action: hasVisibleAnswer && hasDisplayedChecklist ? 'continue' : 'accept',
        reason: hasVisibleAnswer && hasDisplayedChecklist
          ? '最后展示给用户的 turn 里既有真正答复也有 checklist，需要按整个展示 turn 判断。'
          : 'review prompt missed part of the visible turn',
        continuationPrompt: hasVisibleAnswer && hasDisplayedChecklist
          ? '直接补上最后缺的结论，不要重复前面的真正有效答复，也不要重复 checklist。'
          : '',
      }
      : isExplicitBlockerScenario
      ? {
        action: 'accept',
        reason: '这是明确依赖用户确认的破坏性动作。',
        continuationPrompt: '',
      }
      : isOpenOfferScenario
      ? {
        action: hasOpenOfferHardRule ? 'maybe' : 'accept',
        reason: hasOpenOfferHardRule
          ? '这种“如果你愿意我就继续”的结尾不算完成。'
          : 'review prompt missed the explicit open-offer rule.',
        continuationPrompt: hasOpenOfferHardRule
          ? '直接把最终结论给出来，不要再征求许可。'
          : '',
      }
      : isPseudoForkScenario
      ? {
        action: hasBranchFirstRule ? 'continue' : 'accept',
        reason: hasBranchFirstRule
          ? '这不是需要用户拍板的真实分叉，应该沿单流程继续。'
          : 'review prompt missed the branch-first continuation rule.',
        continuationPrompt: hasBranchFirstRule
          ? '不要让用户选方向，直接给出先判断真实分叉、没有就继续的原则。'
          : '',
      }
      : {
        action: prefersContinuationWithoutExplicitBlocker && flagsAnalysisWithoutExecution ? 'continue' : 'accept',
        reason: prefersContinuationWithoutExplicitBlocker && flagsAnalysisWithoutExecution
          ? '上一条回复把本轮该直接交付的内容留到了后面。'
          : 'reviewer prompt did not default to continuing when no explicit blocker existed.',
        continuationPrompt: prefersContinuationWithoutExplicitBlocker && flagsAnalysisWithoutExecution
          ? '直接给出那份极短执行守则，不要再征求许可，也不要重复前面的机制分析。'
          : '',
      }) + '</hide>',
  }];
} else if (isRepairPrompt) {
  threadId = 'repair-thread';
  const isChecklistScenario = prompt.includes('todo checklist');
  const isOpenOfferScenario = prompt.includes('如果你愿意我现在就把最终结论直接发出来');
  const isPseudoForkScenario = prompt.includes('你选一个我再继续');
  const hasVisibleAnswer = prompt.includes('真正有效答复：把缺的结论直接补齐。');
  const hasDisplayedChecklist = prompt.includes('[ ] todo checklist');
  items = [{
    type: 'agent_message',
    text: isChecklistScenario
      ? (hasVisibleAnswer && hasDisplayedChecklist
        ? '补上的最终结论。'
        : 'repair prompt missed part of the visible turn')
      : isOpenOfferScenario
      ? (replacesOpenOfferWithResult
        ? '最终结论：默认直接做；只有在确实缺少用户输入时才停下来。'
        : '如果你愿意我可以继续把最终结论发出来。')
      : isPseudoForkScenario
      ? (avoidsFakeChoiceRepair
        ? '最终原则：先判断有没有真实分叉；没有就直接继续，不要把单流程任务伪装成“你选一下方向”。'
        : '这里有几个方向，你先选一个我再继续。')
      : (prefersDoingWork
        ? '极短执行守则：默认先做完再汇报；除非高风险、真歧义、缺关键信息，否则不要停；不要用“如果你愿意我下一条再做”作为结尾。'
        : '我会继续把极短执行守则补出来。'),
  }];
} else if (prompt.includes('先给真正答复，再在最后发一份 todo checklist，然后停住。')) {
  items = [
    { type: 'agent_message', text: '真正有效答复：把缺的结论直接补齐。' },
    { type: 'todo_list', items: [{ completed: false, text: 'todo checklist' }] },
  ];
} else if (prompt.includes('危险删除场景')) {
  items = [{
    type: 'agent_message',
    text: '这一步会永久删除生产数据，需要你先明确确认，我才能继续执行。',
  }];
} else if (prompt.includes('延迟附件复核场景')) {
  const relativeOutputPath = 'generated/delayed-review-output.mp4';
  writeGeneratedResultAsset(relativeOutputPath);
  items = [
    {
      type: 'command_execution',
      command: 'render --output ' + relativeOutputPath,
      aggregated_output: 'generated to ' + relativeOutputPath,
      exit_code: 0,
      status: 'completed',
    },
    {
      type: 'agent_message',
      text: '导出文件已经生成；但删除原件这一步需要你先明确确认，我才能继续执行。',
    },
  ];
} else if (prompt.includes('延迟复核场景')) {
  items = [{
    type: 'agent_message',
    text: '这一步会永久删除生产数据，需要你先明确确认，我才能继续执行。',
  }];
}

function emitTurn() {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  for (const item of items) {
    console.log(JSON.stringify({
      type: 'item.completed',
      item,
    }));
  }
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  setTimeout(() => process.exit(0), 20);
}

if (outputDelayMs > 0) {
  setTimeout(emitTurn, outputDelayMs);
} else {
  emitTurn();
}
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

process.env.HOME = tempHome;
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  getHistory,
  getSession,
  getSessionTimelineEvents,
  killAll,
  sendMessage,
} = sessionManager;

async function waitFor(predicate, description, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${description}`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveQuickly(load, description, timeoutMs = 200) {
  const result = await Promise.race([
    load().then((value) => ({ status: 'resolved', value })),
    sleep(timeoutMs).then(() => ({ status: 'timeout' })),
  ]);
  assert.equal(result?.status, 'resolved', description);
  return result.value;
}

try {
  const session = await createSession(tempHome, 'fake-codex', 'Reply Self Check', {
    group: 'RemoteLab',
    description: 'Verify end-of-turn self-check can auto-continue an avoidably unfinished reply.',
  });

  await sendMessage(session.id, '先分析问题，再把极短执行守则真的给出来。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const history = await getHistory(session.id);
      return history.some((event) => event.type === 'message' && event.role === 'assistant' && (event.content || '').includes('极短执行守则：'));
    },
    'self-check should trigger an automatic follow-up reply',
  );

  await waitFor(
    async () => (await getSession(session.id))?.activity?.run?.state === 'idle',
    'session should become idle after the automatic follow-up reply',
  );

  const history = await getHistory(session.id);
  const statusTexts = history
    .filter((event) => event.type === 'status')
    .map((event) => event.content || '');
  const continuationOperations = history
    .filter((event) => event.type === 'context_operation' && event.operation === 'continue_turn');
  const assistantTexts = history
    .filter((event) => event.type === 'message' && event.role === 'assistant')
    .map((event) => event.content || '');

  assert.ok(
    statusTexts.includes('Assistant self-check: reviewing the latest reply for early stop…'),
    'history should show that the self-check reviewer ran',
  );
  assert.ok(
    statusTexts.some((text) => text.startsWith('Assistant self-check: continuing automatically — ')),
    'history should show that the self-check requested an automatic continuation',
  );
  assert.ok(
    continuationOperations.some((event) => event.phase === 'queued' && event.title === 'Automatic continuation reviewing'),
    'history should expose a visible queued context operation while automatic continuation is being reviewed',
  );
  assert.ok(
    continuationOperations.some((event) => event.phase === 'applied' && event.title === 'Automatic continuation started' && event.trigger === 'automatic'),
    'history should expose a visible applied context operation when automatic continuation starts',
  );
  assert.ok(
    assistantTexts.some((text) => text.includes('下一条我可以直接给你那份极短执行守则')),
    'history should keep the original avoidably unfinished reply',
  );
  assert.ok(
    assistantTexts.some((text) => text.includes('极短执行守则：默认先做完再汇报')),
    'history should include the automatically continued reply',
  );

  const openOfferSession = await createSession(tempHome, 'fake-codex', 'Reply Self Check Open Offer', {
    group: 'RemoteLab',
    description: 'Verify self-check force-continues replies that stop at an open offer like “if you want I can…”.',
  });

  await sendMessage(openOfferSession.id, '开放式邀约场景：别停在“如果你愿意”，直接把最终结论给出来。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const openOfferHistory = await getHistory(openOfferSession.id);
      return openOfferHistory.some((event) => event.type === 'message' && event.role === 'assistant' && (event.content || '').includes('最终结论：默认直接做'));
    },
    'self-check should auto-continue replies that stop at an open offer',
  );

  await waitFor(
    async () => (await getSession(openOfferSession.id))?.activity?.run?.state === 'idle',
    'open-offer session should become idle after the automatic follow-up reply',
  );

  const openOfferHistory = await getHistory(openOfferSession.id);
  const openOfferStatusTexts = openOfferHistory
    .filter((event) => event.type === 'status')
    .map((event) => event.content || '');
  const openOfferAssistantTexts = openOfferHistory
    .filter((event) => event.type === 'message' && event.role === 'assistant')
    .map((event) => event.content || '');

  assert.ok(
    openOfferStatusTexts.includes('Assistant self-check: reviewing the latest reply for early stop…'),
    'open-offer scenario should still run the self-check reviewer',
  );
  assert.ok(
    openOfferStatusTexts.some((text) => text.startsWith('Assistant self-check: continuing automatically — ')),
    'open-offer scenario should trigger automatic continuation',
  );
  assert.ok(
    openOfferAssistantTexts.some((text) => text.includes('如果你愿意我现在就把最终结论直接发出来')),
    'history should keep the original open-offer reply',
  );
  assert.ok(
    openOfferAssistantTexts.some((text) => text.includes('最终结论：默认直接做')),
    'history should include the replacement reply with the actual result',
  );
  assert.equal(
    openOfferAssistantTexts.some((text) => text.includes('如果你愿意我可以继续把最终结论发出来')),
    false,
    'repair continuation should replace the open offer instead of repeating it',
  );

  const pseudoForkSession = await createSession(tempHome, 'fake-codex', 'Reply Self Check Pseudo Fork', {
    group: 'RemoteLab',
    description: 'Verify self-check continues through a fake choice when the task is still a single flow.',
  });

  await sendMessage(pseudoForkSession.id, '伪分叉场景：这是单流程任务，不要停在让我选方向。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const pseudoForkHistory = await getHistory(pseudoForkSession.id);
      return pseudoForkHistory.some((event) => event.type === 'message' && event.role === 'assistant' && (event.content || '').includes('最终原则：先判断有没有真实分叉'));
    },
    'self-check should auto-continue through a fake branch pause when no real fork exists',
  );

  await waitFor(
    async () => (await getSession(pseudoForkSession.id))?.activity?.run?.state === 'idle',
    'pseudo-fork session should become idle after the automatic follow-up reply',
  );

  const pseudoForkHistory = await getHistory(pseudoForkSession.id);
  const pseudoForkStatusTexts = pseudoForkHistory
    .filter((event) => event.type === 'status')
    .map((event) => event.content || '');
  const pseudoForkAssistantTexts = pseudoForkHistory
    .filter((event) => event.type === 'message' && event.role === 'assistant')
    .map((event) => event.content || '');

  assert.ok(
    pseudoForkStatusTexts.includes('Assistant self-check: reviewing the latest reply for early stop…'),
    'pseudo-fork scenario should still run the self-check reviewer',
  );
  assert.ok(
    pseudoForkStatusTexts.some((text) => text.startsWith('Assistant self-check: continuing automatically — ')),
    'pseudo-fork scenario should trigger automatic continuation',
  );
  assert.ok(
    pseudoForkAssistantTexts.some((text) => text.includes('你选一个我再继续')),
    'history should keep the original fake-choice reply',
  );
  assert.ok(
    pseudoForkAssistantTexts.some((text) => text.includes('最终原则：先判断有没有真实分叉')),
    'history should include the automatic continuation that restores the single-flow principle',
  );
  assert.equal(
    pseudoForkAssistantTexts.some((text) => text.includes('这里有几个方向，你先选一个我再继续。')),
    false,
    'repair continuation should not repeat the fake choice prompt',
  );

  const delayedReviewSession = await createSession(tempHome, 'fake-codex', 'Reply Self Check Delayed Review State', {
    group: 'RemoteLab',
    description: 'Verify a session stays running and defers workflow completion state while reply self-check is still pending.',
  });

  await sendMessage(delayedReviewSession.id, '延迟复核场景：这是明确依赖用户确认的破坏性动作，先停下来等我确认。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const delayedHistory = await getHistory(delayedReviewSession.id);
      return delayedHistory.some((event) => event.type === 'status' && (event.content || '') === 'Assistant self-check: reviewing the latest reply for early stop…');
    },
    'delayed review scenario should enter the self-check review state',
  );

  // After the run completes, the session is idle during the background self-check
  // review. There is no in-memory shadow "running" state — activeRunId is the
  // single source of truth.
  let delayedDuringReview = null;
  await waitFor(
    async () => {
      delayedDuringReview = await getSession(delayedReviewSession.id);
      return delayedDuringReview?.activity?.run?.state === 'idle'
        && (delayedDuringReview?.workflowState || '') === '';
    },
    'session should be idle during background self-check review (no shadow running state)',
  );

  assert.equal(
    delayedDuringReview?.activity?.run?.state,
    'idle',
    'session should be idle while background self-check reviews — activeRunId is the sole busy signal',
  );
  assert.equal(
    delayedDuringReview?.workflowState || '',
    '',
    'workflow classification should not update before self-check finishes',
  );

  const delayedTimelineDuringReview = await resolveQuickly(
    () => getSessionTimelineEvents(delayedReviewSession.id),
    'timeline reads should not wait for delayed reply self-check completion',
  );
  assert.ok(
    delayedTimelineDuringReview.some(
      (event) => event.type === 'status' && event.content === 'Assistant self-check: reviewing the latest reply for early stop…',
    ),
    'timeline reads should still include the in-flight self-check reviewing state',
  );

  await waitFor(
    async () => (await getSession(delayedReviewSession.id))?.activity?.run?.state === 'idle',
    'delayed review session should become idle after the self-check accept path',
  );

  await waitFor(
    async () => (await getSession(delayedReviewSession.id))?.workflowState === 'done',
    'workflow classification should update only after the delayed self-check finishes',
  );

  const delayedAssetReviewSession = await createSession(tempHome, 'fake-codex', 'Reply Self Check Delayed Review With Result Asset', {
    group: 'RemoteLab',
    description: 'Verify generated result assets do not make the session look idle or complete before a delayed reply self-check finishes.',
  });

  await sendMessage(delayedAssetReviewSession.id, '延迟附件复核场景：先把导出文件做出来，但删除原件之前先等我确认。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const delayedAssetHistory = await getHistory(delayedAssetReviewSession.id);
      return delayedAssetHistory.some((event) => event.type === 'status' && (event.content || '') === 'Assistant self-check: reviewing the latest reply for early stop…');
    },
    'delayed asset review scenario should enter the self-check review state',
  );

  await waitFor(
    async () => {
      const delayedAssetHistory = await getHistory(delayedAssetReviewSession.id);
      return delayedAssetHistory.some(
        (event) => event.type === 'message' && event.role === 'assistant' && event.source === 'result_file_assets',
      );
    },
    'generated result asset message should appear before the delayed self-check finishes',
  );

  const delayedAssetHistory = await getHistory(delayedAssetReviewSession.id);
  const delayedAssetMessage = delayedAssetHistory.find((event) => (
    event.type === 'message'
    && event.role === 'assistant'
    && event.source === 'result_file_assets'
  ));
  assert.ok(delayedAssetMessage, 'history should include the generated result asset message');
  assert.equal(
    delayedAssetMessage?.content,
    'Generated file ready to download.',
    'single generated result asset should use the singular download-ready copy',
  );
  assert.equal(
    delayedAssetMessage?.attachments?.length,
    1,
    'generated result asset message should expose the published attachment while self-check is pending',
  );

  const delayedAssetTimelineDuringReview = await resolveQuickly(
    () => getSessionTimelineEvents(delayedAssetReviewSession.id),
    'timeline reads should not wait for delayed asset self-check completion',
  );
  assert.ok(
    delayedAssetTimelineDuringReview.some(
      (event) => event.type === 'message' && event.role === 'assistant' && event.source === 'result_file_assets',
    ),
    'timeline reads should still expose generated result assets while self-check is pending',
  );

  await waitFor(
    async () => (await getSession(delayedAssetReviewSession.id))?.activity?.run?.state === 'idle',
    'delayed asset review session should become idle after the self-check accept path',
  );

  const delayedAssetSettledHistory = await getHistory(delayedAssetReviewSession.id);
  const delayedAssetAcceptStatus = delayedAssetSettledHistory.find((event) => (
    event.type === 'status'
    && event.content === 'Assistant self-check: kept the latest reply as-is.'
  ));
  assert.ok(delayedAssetAcceptStatus, 'delayed asset review history should eventually include the self-check accept status');
  assert.ok(
    Number.isInteger(delayedAssetMessage?.seq)
      && Number.isInteger(delayedAssetAcceptStatus?.seq)
      && delayedAssetMessage.seq < delayedAssetAcceptStatus.seq,
    'generated result asset message should land in history before the delayed self-check accept path finishes',
  );

  await waitFor(
    async () => (await getSession(delayedAssetReviewSession.id))?.workflowState === 'done',
    'workflow classification should update only after the delayed asset review self-check finishes',
  );

  const blockerSession = await createSession(tempHome, 'fake-codex', 'Reply Self Check Explicit Blocker', {
    group: 'RemoteLab',
    description: 'Verify self-check accepts a reply that stops for an explicit user-side destructive blocker.',
  });

  await sendMessage(blockerSession.id, '危险删除场景：如果继续就会永久删除生产数据，这时先停下来等我确认。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const blockerHistory = await getHistory(blockerSession.id);
      return blockerHistory.some((event) => event.type === 'status' && (event.content || '') === 'Assistant self-check: kept the latest reply as-is.');
    },
    'self-check should accept an explicitly blocked destructive reply',
  );

  await waitFor(
    async () => (await getSession(blockerSession.id))?.activity?.run?.state === 'idle',
    'blocker session should become idle after the self-check accept path',
  );

  const blockerHistory = await getHistory(blockerSession.id);
  const blockerStatusTexts = blockerHistory
    .filter((event) => event.type === 'status')
    .map((event) => event.content || '');
  const blockerContinuationOperations = blockerHistory
    .filter((event) => event.type === 'context_operation' && event.operation === 'continue_turn');
  const blockerAssistantTexts = blockerHistory
    .filter((event) => event.type === 'message' && event.role === 'assistant')
    .map((event) => event.content || '');

  assert.ok(
    blockerStatusTexts.includes('Assistant self-check: reviewing the latest reply for early stop…'),
    'blocker scenario should still run the self-check reviewer',
  );
  assert.ok(
    blockerStatusTexts.includes('Assistant self-check: kept the latest reply as-is.'),
    'blocker scenario should keep the original reply when a real blocker exists',
  );
  assert.equal(
    blockerStatusTexts.some((text) => text.startsWith('Assistant self-check: continuing automatically — ')),
    false,
    'blocker scenario should not auto-continue past a real user-side blocker',
  );
  assert.ok(
    blockerContinuationOperations.some((event) => event.phase === 'queued' && event.title === 'Automatic continuation reviewing'),
    'blocker scenario should still expose the visible review operation before deciding not to continue',
  );
  assert.ok(
    blockerContinuationOperations.some((event) => event.phase === 'skipped' && event.title === 'Automatic continuation not needed'),
    'blocker scenario should expose a visible skipped context operation when automatic continuation is not needed',
  );
  assert.deepEqual(
    blockerAssistantTexts,
    ['这一步会永久删除生产数据，需要你先明确确认，我才能继续执行。'],
    'blocker scenario should preserve the single user-visible reply without adding an automatic continuation',
  );

  const checklistSession = await createSession(tempHome, 'fake-codex', 'Reply Self Check Visible Turn', {
    group: 'RemoteLab',
    description: 'Verify self-check reuses the visible turn display when a checklist is the final assistant item.',
  });

  await sendMessage(checklistSession.id, '先给真正答复，再在最后发一份 todo checklist，然后停住。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const visibleTurnHistory = await getHistory(checklistSession.id);
      return visibleTurnHistory.some((event) => event.type === 'message' && event.role === 'assistant' && (event.content || '').includes('补上的最终结论。'));
    },
    'self-check should inspect the whole displayed assistant turn instead of only the last checklist item',
  );

  await waitFor(
    async () => (await getSession(checklistSession.id))?.activity?.run?.state === 'idle',
    'checklist session should become idle after the automatic follow-up reply',
  );

  const checklistHistory = await getHistory(checklistSession.id);
  const checklistAssistantTexts = checklistHistory
    .filter((event) => event.type === 'message' && event.role === 'assistant')
    .map((event) => event.content || '');

  assert.ok(
    checklistAssistantTexts.some((text) => text.includes('真正有效答复：把缺的结论直接补齐。')),
    'history should keep the visible substantive assistant reply that appeared before the checklist',
  );
  assert.ok(
    checklistAssistantTexts.some((text) => text.includes('[ ] todo checklist')),
    'history should keep the trailing checklist that ended the original assistant turn',
  );
  assert.ok(
    checklistAssistantTexts.some((text) => text.includes('补上的最终结论。')),
    'repair continuation should still see the whole displayed assistant turn context',
  );
  assert.equal(
    checklistAssistantTexts.some((text) => text.includes('repair prompt missed part of the visible turn')),
    false,
    'repair prompt should not fall back to a missing-context placeholder',
  );
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-reply-self-check: ok');
