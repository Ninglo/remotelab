#!/usr/bin/env node
// A deterministic protocol peer: no authentication, networking, or model calls.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (!process.argv.includes('app-server')) { console.log('codex-cli native-test'); process.exit(0); }
const root = process.env.HOME;
const runId = process.env.REMOTELAB_RUN_ID;
let nextTurn = 0, activeTurn = '', released = false, finalText = 'durable native answer';
let holdQuestion = false;
let heldOpeningAck = null;
const log = event => fs.appendFileSync(path.join(root, 'native-log.jsonl'), JSON.stringify({ ...event, runId, pid: process.pid }) + '\n');
const emit = message => console.log(JSON.stringify(message));
const notify = (method, params) => emit({ method, params: { threadId: 'native-thread', ...params } });
const finish = (status = 'completed', answer = true) => {
  if (!activeTurn) return;
  const id = activeTurn; activeTurn = '';
  if (answer) notify('item/completed', { turnId: id, item: { id: `answer-${id}`, type: 'agentMessage', text: finalText, phase: 'final_answer' } });
  notify('turn/completed', { turn: { id, status, items: [] } });
  log({ kind: 'completed', turnId: id, status });
};
const askQuestion = (asyncQuestion = false) => {
  holdQuestion = true;
  if (asyncQuestion) {
    notify('item/completed', { turnId: activeTurn, item: { id: 'async-question', type: 'agentMessage', delivery: 'async',
      questions: [{ title: '选择输出形式？', options: ['简短', '详细'] }] } });
    finish('completed', false);
  } else emit({ id: 'question-request', method: 'item/tool/requestUserInput', params: {
    threadId: 'native-thread', turnId: activeTurn, itemId: 'question-tool', isBlocking: true,
    questions: [{ id: 'format', question: '选择输出形式？', options: [{ label: '简短' }, { label: '详细' }] }],
  } });
};
log({ kind: 'process-start' });
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  const { method, params = {}, id } = request;
  const text = (params.input || []).map(value => value.text || '').join('\n');
  if (id === 'question-request' && request.result) { log({ kind: 'question-answer', result: request.result }); if (!holdQuestion) finish(); return; }
  log({ kind: method, text, clientId: params.clientUserMessageId || null, expectedTurnId: params.expectedTurnId });
  if (method === 'initialize') emit({ id, result: {} });
  else if (method === 'thread/start' || method === 'thread/resume') emit({ id, result: { thread: { id: 'native-thread' } } });
  else if (method === 'turn/start') {
    activeTurn = `turn-${++nextTurn}`;
    emit({ id, result: { turn: { id: activeTurn, status: 'inProgress' } } });
    notify('turn/started', { turn: { id: activeTurn, status: 'inProgress' } });
    if (text.includes('PUBLISH_OPENING')) notify('item/completed', { turnId: activeTurn, item: {
      id: `opening-${params.clientUserMessageId}`, type: 'agentMessage', phase: 'commentary', text: 'Opening for the original request.',
    } });
    if (text.includes('ASK_NATIVE_QUESTION')) emit({ id: 'question-request', method: 'item/tool/requestUserInput', params: {
      threadId: 'native-thread', turnId: activeTurn, itemId: 'question-tool', isBlocking: true,
      questions: [{ id: 'format', question: '选择输出形式？', header: '形式', options: [{ label: '简短', description: '摘要' }, { label: '详细', description: '完整内容' }] }],
    } });
  } else if (method === 'turn/steer') {
    if (text.includes('REJECT_NATIVE_INPUT')) {
      emit({ id, error: { code: -32602, message: 'Input exceeds maximum length' } });
    } else if (text.includes('RACE_NATIVE_COMPLETION')) {
      finish('completed', false);
      emit({ id, error: { code: -32600, message: 'no active turn to steer' } });
    } else if (params.expectedTurnId !== activeTurn || !activeTurn) {
      emit({ id, error: { code: -32600, message: 'no active turn to steer' } });
    } else {
      if (text.includes('HOLD_OPENING_ACK')) {
        notify('item/completed', { turnId: activeTurn, item: {
          id: `opening-${params.clientUserMessageId}`, type: 'agentMessage', phase: 'commentary', text: 'Supplement accepted; I will verify its actual state.',
        } });
        heldOpeningAck = { id, turnId: activeTurn };
        return;
      }
      emit({ id, result: { turnId: activeTurn } });
      if (text.includes('ASK_ON_STEER')) askQuestion();
      if (text.includes('ASK_ASYNC_ON_STEER')) askQuestion(true);
      if (text.includes('RELEASE_NATIVE')) finish();
      if (text.includes('FAIL_NATIVE_TURN')) finish('failed', false);
      if (text.includes('PUBLISH_FINAL_EARLY') || text.includes('PUBLISH_FINAL_FILE_EARLY')) {
        if (text.includes('PUBLISH_FINAL_FILE_EARLY')) {
          const file = path.join(root, 'early-result.txt');
          fs.writeFileSync(file, 'ready file result');
          finalText = `文件已准备好。\n\nArtifacts:\n- ${file}`;
        }
        notify('item/completed', { turnId: activeTurn, item: {
          id: `answer-${activeTurn}`, type: 'agentMessage', phase: 'final_answer', text: finalText,
        } });
        notify('item/completed', { turnId: activeTurn, item: {
          id: `progress-${activeTurn}`, type: 'agentMessage', phase: 'commentary', text: 'Continuing after the final answer',
        } });
        log({ kind: 'early-final', turnId: activeTurn });
      }
    }
  } else if (method === 'turn/interrupt') {
    emit({ id, result: {} }); finish('interrupted', false);
  }
});
const timer = setInterval(() => {
  if (heldOpeningAck && fs.existsSync(path.join(root, `${runId}.ack`))) {
    emit({ id: heldOpeningAck.id, result: { turnId: heldOpeningAck.turnId } });
    heldOpeningAck = null;
  }
  if (!released && activeTurn && fs.existsSync(path.join(root, `${runId}.release`))) {
    released = true; finish();
  }
}, 15);
lines.on('close', () => { clearInterval(timer); log({ kind: 'stdin-closed' }); process.exit(0); });
