#!/usr/bin/env node
// A deterministic protocol peer: no authentication, networking, or model calls.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (!process.argv.includes('app-server')) { console.log('codex-cli native-test'); process.exit(0); }
const root = process.env.HOME;
const runId = process.env.REMOTELAB_RUN_ID;
let nextTurn = 0, activeTurn = '', released = false;
const log = event => fs.appendFileSync(path.join(root, 'native-log.jsonl'), JSON.stringify({ ...event, runId, pid: process.pid }) + '\n');
const emit = message => console.log(JSON.stringify(message));
const notify = (method, params) => emit({ method, params: { threadId: 'native-thread', ...params } });
const finish = (status = 'completed', answer = true) => {
  if (!activeTurn) return;
  const id = activeTurn; activeTurn = '';
  if (answer) notify('item/completed', { turnId: id, item: { id: `answer-${id}`, type: 'agentMessage', text: 'durable native answer', phase: 'final_answer' } });
  notify('turn/completed', { turn: { id, status, items: [] } });
  log({ kind: 'completed', turnId: id, status });
};
log({ kind: 'process-start' });
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  const { method, params = {}, id } = request;
  const text = (params.input || []).map(value => value.text || '').join('\n');
  log({ kind: method, text, clientId: params.clientUserMessageId || null, expectedTurnId: params.expectedTurnId });
  if (method === 'initialize') emit({ id, result: {} });
  else if (method === 'thread/start' || method === 'thread/resume') emit({ id, result: { thread: { id: 'native-thread' } } });
  else if (method === 'turn/start') {
    activeTurn = `turn-${++nextTurn}`;
    emit({ id, result: { turn: { id: activeTurn, status: 'inProgress' } } });
    notify('turn/started', { turn: { id: activeTurn, status: 'inProgress' } });
  } else if (method === 'turn/steer') {
    if (text.includes('REJECT_NATIVE_INPUT')) {
      emit({ id, error: { code: -32602, message: 'Input exceeds maximum length' } });
    } else if (text.includes('RACE_NATIVE_COMPLETION')) {
      finish('completed', false);
      emit({ id, error: { code: -32600, message: 'no active turn to steer' } });
    } else if (params.expectedTurnId !== activeTurn || !activeTurn) {
      emit({ id, error: { code: -32600, message: 'no active turn to steer' } });
    } else emit({ id, result: { turnId: activeTurn } });
  } else if (method === 'turn/interrupt') {
    emit({ id, result: {} }); finish('interrupted', false);
  }
});
const timer = setInterval(() => {
  if (!released && activeTurn && fs.existsSync(path.join(root, `${runId}.release`))) {
    released = true; finish();
  }
}, 15);
lines.on('close', () => { clearInterval(timer); log({ kind: 'stdin-closed' }); process.exit(0); });
