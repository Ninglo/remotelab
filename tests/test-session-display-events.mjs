#!/usr/bin/env node
import assert from 'assert/strict';
import {
  buildEventBlockEvents,
  buildSessionDisplayEvents,
} from './chat/session-display-events.mjs';

const interleavedTurnHistory = [
  { seq: 1, type: 'message', role: 'user', content: 'Please summarize the work' },
  { seq: 2, type: 'status', role: 'system', content: 'thinking' },
  { seq: 3, type: 'reasoning', role: 'assistant', content: 'Inspecting repository state' },
  { seq: 4, type: 'status', role: 'system', content: 'Running tool A' },
  { seq: 5, type: 'tool_use', role: 'assistant', toolName: 'shell', toolInput: 'ls -la' },
  { seq: 6, type: 'tool_result', role: 'system', output: 'file list', exitCode: 0 },
  { seq: 7, type: 'message', role: 'assistant', content: 'Final summary' },
  { seq: 8, type: 'usage', role: 'system', contextTokens: 1200, outputTokens: 42 },
];

const interleavedDisplay = buildSessionDisplayEvents(interleavedTurnHistory, { sessionRunning: false });
assert.deepEqual(
  interleavedDisplay.map((event) => event.type),
  ['message', 'thinking_block', 'message', 'usage'],
  'turn display should collapse intermediate turn content and keep only the final assistant summary visible',
);
assert.equal(interleavedDisplay[1].blockStartSeq, 3, 'collapsed range should begin with the first intermediate event after the user message');
assert.equal(interleavedDisplay[1].blockEndSeq, 6, 'collapsed range should extend through the final hidden event before the summary');
assert.equal(interleavedDisplay[1].label, 'Thought · used shell', 'completed blocks should reuse the same thought label family as the running block');

const interleavedBlockEvents = buildEventBlockEvents(interleavedTurnHistory, 3, 6);
assert.deepEqual(
  interleavedBlockEvents.map((event) => event.type),
  ['reasoning', 'status', 'tool_use', 'tool_result'],
  'collapsed block payload should still expose the folded implementation events on demand',
);

const narratedProgressHistory = [
  { seq: 1, type: 'message', role: 'user', content: 'Investigate this issue' },
  { seq: 2, type: 'reasoning', role: 'assistant', content: 'Starting the investigation' },
  { seq: 3, type: 'message', role: 'assistant', runtimeFamily: 'pi-json', content: 'I found the relevant module.' },
  { seq: 4, type: 'usage', role: 'system', contextTokens: 1000, outputTokens: 20 },
  { seq: 5, type: 'tool_use', role: 'assistant', toolName: 'read', toolInput: 'module.js' },
  { seq: 6, type: 'tool_result', role: 'system', output: 'source', exitCode: 0 },
  { seq: 7, type: 'message', role: 'assistant', runtimeFamily: 'pi-json', content: 'The issue is in the event projection.' },
  { seq: 8, type: 'usage', role: 'system', contextTokens: 1200, outputTokens: 35 },
];

const narratedProgressDisplay = buildSessionDisplayEvents(narratedProgressHistory, { sessionRunning: false });
assert.deepEqual(
  narratedProgressDisplay.map((event) => event.type),
  ['message', 'thinking_block', 'message', 'message', 'usage'],
  'completed turns should keep one Thought row, plain progress text, the final answer, and one final usage summary',
);
assert.equal(narratedProgressDisplay.filter((event) => event.type === 'thinking_block').length, 1);
assert.deepEqual(narratedProgressDisplay[1].visibleMessageSeqs, [3]);
assert.equal(narratedProgressDisplay[2].messageKind, 'progress');
assert.equal(narratedProgressDisplay[2].content, 'I found the relevant module.');
assert.equal(narratedProgressDisplay[3].messageKind, undefined);
assert.equal(narratedProgressDisplay[3].content, 'The issue is in the event projection.');
assert.equal(narratedProgressDisplay.filter((event) => event.type === 'usage').length, 1);
assert.equal(narratedProgressDisplay.at(-1).contextTokens, 1200);

const nonPiNarratedHistory = narratedProgressHistory.map((event) => (
  event.runtimeFamily === 'pi-json' ? { ...event, runtimeFamily: 'codex-json' } : event
));
assert.deepEqual(
  buildSessionDisplayEvents(nonPiNarratedHistory, { sessionRunning: false }).map((event) => event.type),
  ['message', 'thinking_block', 'message', 'usage'],
  'the lightweight progress projection should stay scoped to Pi instead of changing every runtime UI',
);

const leadingVisibleStatusHistory = [
  { seq: 1, type: 'message', role: 'user', content: 'Do the thing' },
  { seq: 2, type: 'status', role: 'system', content: 'Preparing environment' },
  { seq: 3, type: 'reasoning', role: 'assistant', content: 'Checking dependencies' },
  { seq: 4, type: 'tool_use', role: 'assistant', toolName: 'shell', toolInput: 'npm test' },
  { seq: 5, type: 'message', role: 'assistant', content: 'Done summary' },
];

const leadingVisibleDisplay = buildSessionDisplayEvents(leadingVisibleStatusHistory, { sessionRunning: false });
assert.deepEqual(
  leadingVisibleDisplay.map((event) => event.type),
  ['message', 'thinking_block', 'message'],
  'leading visible status updates should also fold into the intermediate collapsed block when a final summary exists',
);
assert.equal(leadingVisibleDisplay[1].blockStartSeq, 2, 'collapsed range should include visible intermediate status events before hidden work');
assert.equal(leadingVisibleDisplay[1].blockEndSeq, 4, 'collapsed range should end at the last hidden implementation event before the summary');
assert.equal(leadingVisibleDisplay[1].label, 'Thought · used shell', 'completed folded blocks should keep the same thought header copy');

const leadingVisibleBlockEvents = buildEventBlockEvents(leadingVisibleStatusHistory, 2, 4);
assert.deepEqual(
  leadingVisibleBlockEvents.map((event) => event.type),
  ['status', 'reasoning', 'tool_use'],
  'folded blocks should preserve visible intermediate status text instead of only keeping hidden tool events',
);

const runningTurnHistory = [
  { seq: 1, type: 'message', role: 'user', content: 'Work on this task' },
  { seq: 2, type: 'status', role: 'system', content: 'Preparing environment' },
  { seq: 3, type: 'reasoning', role: 'assistant', content: 'Inspecting files' },
  { seq: 4, type: 'tool_use', role: 'assistant', toolName: 'bash', toolInput: 'rg TODO' },
  { seq: 5, type: 'tool_result', role: 'system', output: 'matches', exitCode: 0 },
  { seq: 6, type: 'message', role: 'assistant', runtimeFamily: 'pi-json', content: 'I found the relevant TODO and am checking its caller.' },
];

const runningDisplay = buildSessionDisplayEvents(runningTurnHistory, { sessionRunning: true });
assert.deepEqual(
  runningDisplay.map((event) => event.type),
  ['message', 'thinking_block', 'message'],
  'running turns should retain one Thinking row and add only plain assistant progress text',
);
assert.equal(runningDisplay.filter((event) => event.type === 'thinking_block').length, 1);
assert.equal(runningDisplay[1].label, 'Thinking · using bash', 'running turns should use the same thinking block label family as completed turns');
assert.equal(runningDisplay[1].blockStartSeq, 2, 'running collapsed block should start with the first non-user event in the turn');
assert.equal(runningDisplay[1].blockEndSeq, 6, 'the single running block should continue to aggregate the full in-flight range');
assert.deepEqual(runningDisplay[1].visibleMessageSeqs, [6]);
assert.equal(runningDisplay[2].messageKind, 'progress');
assert.equal(runningDisplay[2].content, 'I found the relevant TODO and am checking its caller.');

const runningBlockEvents = buildEventBlockEvents(runningTurnHistory, 2, 6);
assert.deepEqual(
  runningBlockEvents.map((event) => event.type),
  ['status', 'reasoning', 'tool_use', 'tool_result', 'message'],
  'running folded blocks should preserve intermediate assistant text so the page can still reveal everything on demand',
);

const hiddenAttachmentHistory = [
  { seq: 1, type: 'message', role: 'user', content: '把生成文件发给我' },
  { seq: 2, type: 'tool_use', role: 'assistant', toolName: 'bash', toolInput: 'generate-files' },
  { seq: 3, type: 'tool_result', role: 'system', output: 'ok', exitCode: 0 },
  {
    seq: 4,
    type: 'message',
    role: 'assistant',
    runtimeFamily: 'pi-json',
    content: '文件已经生成。',
    attachments: [
      {
        assetId: 'fasset_preview_png',
        originalName: 'preview.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        savedPath: '/tmp/preview.png',
      },
      {
        assetId: 'fasset_notes_txt',
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 512,
        savedPath: '/tmp/notes.txt',
      },
    ],
  },
  { seq: 5, type: 'tool_use', role: 'assistant', toolName: 'bash', toolInput: 'finalize-response' },
  { seq: 6, type: 'tool_result', role: 'system', output: 'done', exitCode: 0 },
  { seq: 7, type: 'message', role: 'assistant', runtimeFamily: 'pi-json', content: '都准备好了。' },
];

const hiddenAttachmentDisplay = buildSessionDisplayEvents(hiddenAttachmentHistory, { sessionRunning: false });
assert.deepEqual(
  hiddenAttachmentDisplay.map((event) => event.type),
  ['message', 'thinking_block', 'message', 'message', 'attachment_delivery'],
  'file turns should keep one Thought row, plain narrated progress, the final answer, and one delivery row',
);
assert.equal(hiddenAttachmentDisplay[2].messageKind, 'progress');
assert.equal(hiddenAttachmentDisplay[2].content, '文件已经生成。');
assert.equal(hiddenAttachmentDisplay[3].content, '都准备好了。');
assert.equal(
  hiddenAttachmentDisplay[4].attachments.length,
  2,
  'the attachment delivery event should surface every hidden assistant attachment once',
);
assert.equal(
  hiddenAttachmentDisplay[4].attachments[0].renderAs,
  'file',
  'bottom attachment deliveries should force file-card rendering for visibility',
);
assert.equal(
  'savedPath' in hiddenAttachmentDisplay[4].attachments[0],
  false,
  'bottom attachment deliveries should not leak host-side saved paths',
);

const hiddenAttachmentBlockEvents = buildEventBlockEvents(hiddenAttachmentHistory, 2, 6);
const hiddenAttachmentBlockMessage = hiddenAttachmentBlockEvents.find(
  (event) => event?.type === 'message' && event.role === 'assistant',
);
assert.ok(
  hiddenAttachmentBlockMessage,
  'expanded hidden blocks should still retain the assistant text that introduced the delivery',
);
assert.equal(
  'attachments' in hiddenAttachmentBlockMessage,
  false,
  'expanded hidden blocks should not duplicate detached assistant attachments inside the thought body',
);

const visibleAttachmentHistory = [
  { seq: 1, type: 'message', role: 'user', content: '把最终文件直接发我' },
  { seq: 2, type: 'tool_use', role: 'assistant', toolName: 'bash', toolInput: 'render-assets' },
  { seq: 3, type: 'tool_result', role: 'system', output: 'ok', exitCode: 0 },
  {
    seq: 4,
    type: 'message',
    role: 'assistant',
    content: '好的，附件在下面。',
    attachments: [
      {
        assetId: 'fasset_final_png',
        originalName: 'final.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
      },
      {
        assetId: 'fasset_final_txt',
        originalName: 'final.txt',
        mimeType: 'text/plain',
        sizeBytes: 128,
      },
    ],
  },
];

const visibleAttachmentDisplay = buildSessionDisplayEvents(visibleAttachmentHistory, { sessionRunning: false });
assert.deepEqual(
  visibleAttachmentDisplay.map((event) => event.type),
  ['message', 'thinking_block', 'message', 'attachment_delivery'],
  'completed turns should also detach assistant attachments into the bottom delivery row',
);
assert.equal(
  'attachments' in visibleAttachmentDisplay[2],
  false,
  'the visible assistant summary should keep its text while moving attachment rendering to the bottom delivery row',
);

const runningAttachmentHistory = [
  { seq: 1, type: 'message', role: 'user', content: '发我一个结果文件' },
  { seq: 2, type: 'tool_use', role: 'assistant', toolName: 'bash', toolInput: 'build-report' },
  { seq: 3, type: 'tool_result', role: 'system', output: 'ok', exitCode: 0 },
  {
    seq: 4,
    type: 'message',
    role: 'assistant',
    attachments: [
      {
        assetId: 'fasset_report_pdf',
        originalName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
      },
    ],
  },
];

const runningAttachmentDisplay = buildSessionDisplayEvents(runningAttachmentHistory, { sessionRunning: true });
assert.deepEqual(
  runningAttachmentDisplay.map((event) => event.type),
  ['message', 'thinking_block', 'attachment_delivery'],
  'running turns should still surface a bottom attachment delivery event while the hidden block stays collapsed',
);

const runningAttachmentBlockEvents = buildEventBlockEvents(runningAttachmentHistory, 2, 4);
assert.deepEqual(
  runningAttachmentBlockEvents.map((event) => event.type),
  ['tool_use', 'tool_result'],
  'expanded running thought blocks should omit attachment-only delivery messages once those attachments are detached to the bottom row',
);

const ignoredStatusBlockEvents = buildEventBlockEvents(interleavedTurnHistory, 2, 6);
assert.equal(
  ignoredStatusBlockEvents.some((event) => event.type === 'status' && event.content === 'thinking'),
  false,
  'transport-only thinking markers should stay omitted from the folded block payload',
);

const managerContextHistory = [
  { seq: 1, type: 'message', role: 'user', content: '继续这个讨论' },
  { seq: 2, type: 'manager_context', role: 'system', content: 'Manager note: keep replies in natural paragraphs.' },
  { seq: 3, type: 'reasoning', role: 'assistant', content: 'Refreshing working agreements' },
  { seq: 4, type: 'message', role: 'assistant', content: '好的，我们继续。' },
];

const managerContextDisplay = buildSessionDisplayEvents(managerContextHistory, { sessionRunning: false });
assert.deepEqual(
  managerContextDisplay.map((event) => event.type),
  ['message', 'thinking_block', 'message'],
  'manager context events should stay hidden inside the folded implementation block by default',
);

const managerContextBlockEvents = buildEventBlockEvents(managerContextHistory, 2, 3);
assert.deepEqual(
  managerContextBlockEvents.map((event) => event.type),
  ['manager_context', 'reasoning'],
  'expanded folded blocks should still expose manager context when explicitly opened',
);

const contextOperationHistory = [
  { seq: 1, type: 'message', role: 'user', content: '继续处理这个会话' },
  { seq: 2, type: 'status', role: 'system', content: 'Preparing environment' },
  { seq: 3, type: 'reasoning', role: 'assistant', content: 'Checking context pressure' },
  {
    seq: 4,
    type: 'context_operation',
    role: 'system',
    title: 'Current context compacted',
    summary: 'Older context was replaced with a continuation summary and handoff.',
    reason: 'Current context exceeded the model window',
    phase: 'applied',
    trigger: 'automatic',
  },
  { seq: 5, type: 'message', role: 'assistant', content: '我已经把旧上下文压成了延续包。' },
];

const contextOperationDisplay = buildSessionDisplayEvents(contextOperationHistory, { sessionRunning: false });
assert.deepEqual(
  contextOperationDisplay.map((event) => event.type),
  ['message', 'thinking_block', 'context_operation', 'message'],
  'context operations should stay visible in the main transcript instead of being folded into the hidden implementation block',
);

const autoContinuationHistory = [
  { seq: 1, type: 'message', role: 'user', content: '把结论完整说完', responseId: 'resp_auto_continue' },
  { seq: 2, type: 'reasoning', role: 'assistant', content: 'Preparing the first answer', responseId: 'resp_auto_continue', runId: 'run_original' },
  { seq: 3, type: 'tool_use', role: 'assistant', toolName: 'shell', toolInput: 'inspect', responseId: 'resp_auto_continue', runId: 'run_original' },
  { seq: 4, type: 'tool_result', role: 'system', output: 'ok', exitCode: 0, responseId: 'resp_auto_continue', runId: 'run_original' },
  { seq: 5, type: 'message', role: 'assistant', content: '第一段：我先说明原因。', responseId: 'resp_auto_continue', runId: 'run_original' },
  { seq: 6, type: 'status', role: 'system', content: 'Assistant self-check: reviewing the latest reply for early stop…' },
  {
    seq: 7,
    type: 'context_operation',
    role: 'system',
    operation: 'continue_turn',
    phase: 'queued',
    trigger: 'automatic',
    title: 'Automatic continuation reviewing',
    summary: 'RemoteLab is checking whether the latest reply stopped too early.',
  },
  { seq: 8, type: 'status', role: 'system', content: 'Assistant self-check: continuing automatically — reply stopped early' },
  {
    seq: 9,
    type: 'context_operation',
    role: 'system',
    operation: 'continue_turn',
    phase: 'applied',
    trigger: 'automatic',
    title: 'Automatic continuation started',
    summary: 'RemoteLab launched a follow-up turn to finish avoidable unfinished work.',
  },
  { seq: 10, type: 'reasoning', role: 'assistant', content: 'Preparing the continuation', responseId: 'resp_auto_continue', runId: 'run_continued' },
  { seq: 11, type: 'tool_use', role: 'assistant', toolName: 'shell', toolInput: 'verify', responseId: 'resp_auto_continue', runId: 'run_continued' },
  { seq: 12, type: 'tool_result', role: 'system', output: 'done', exitCode: 0, responseId: 'resp_auto_continue', runId: 'run_continued' },
  { seq: 13, type: 'message', role: 'assistant', content: '第二段：这是补上的最终结论。', responseId: 'resp_auto_continue', runId: 'run_continued' },
];

const autoContinuationDisplay = buildSessionDisplayEvents(autoContinuationHistory, { sessionRunning: false });
assert.deepEqual(
  autoContinuationDisplay.map((event) => event.type),
  [
    'message',
    'thinking_block',
    'message',
    'status',
    'context_operation',
    'status',
    'context_operation',
    'thinking_block',
    'message',
  ],
  'automatic self-check continuations should keep both user-visible assistant reply parts in the main transcript',
);
const autoContinuationAssistantMessages = autoContinuationDisplay.filter(
  (event) => event.type === 'message' && event.role === 'assistant',
);
assert.deepEqual(
  autoContinuationAssistantMessages.map((event) => event.content),
  ['第一段：我先说明原因。', '第二段：这是补上的最终结论。'],
  'automatic continuation display should expose the original visible reply and the repair reply together',
);
assert.equal(autoContinuationDisplay[1].blockStartSeq, 2, 'original-run hidden work should stay in its own folded block');
assert.equal(autoContinuationDisplay[1].blockEndSeq, 4, 'original-run folded block should stop before the first visible reply');
assert.equal(autoContinuationDisplay[7].blockStartSeq, 10, 'repair-run hidden work should stay folded after the self-check drawer');
assert.equal(autoContinuationDisplay[7].blockEndSeq, 12, 'repair-run folded block should stop before the continued visible reply');

console.log('test-session-display-events: ok');
