#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');

if (!process.argv.includes('app-server')) process.exit(2);

const sequenceFile = process.env.PREFLIGHT_SEQUENCE_FILE || '';
let answer = process.env.PREFLIGHT_ANSWER || '3.1';
if (sequenceFile) {
  let sequence = 0;
  try { sequence = Number.parseInt(fs.readFileSync(sequenceFile, 'utf8'), 10) || 0; } catch {}
  fs.writeFileSync(sequenceFile, String(sequence + 1));
  answer = sequence === 0 ? '2.5' : '3.1';
}
const logPath = process.env.PREFLIGHT_LOG || '';
let turnSequence = 0;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const log = (value) => {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(value)}\n`);
};
const notify = (method, params) => emit({ method, params: { threadId: 'preflight-thread', ...params } });

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    emit({ id, result: {} });
    return;
  }
  if (method === 'thread/start') {
    emit({ id, result: { thread: { id: 'preflight-thread' } } });
    return;
  }
  if (method !== 'turn/start') return;
  const text = (params.input || []).map((entry) => entry.text || '').join('\n');
  const turnId = `turn-${++turnSequence}`;
  log({ turnId, text });
  emit({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
  notify('turn/started', { turn: { id: turnId, status: 'inProgress' } });
  const responseText = text.includes('PREFLIGHT_MARKER') ? answer : 'actual visible answer';
  notify('item/completed', {
    turnId,
    item: { id: `answer-${turnId}`, type: 'agentMessage', text: responseText, phase: 'final_answer' },
  });
  notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } });
});
input.on('close', () => process.exit(0));
