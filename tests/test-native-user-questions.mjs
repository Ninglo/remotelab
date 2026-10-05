import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once, EventEmitter } from 'node:events';
import { createNativeQuestionBroker, readNativeQuestion, resolveQuestionAnswer, nativeQuestionAnswers, nativeQuestionReplyText, QUESTION_TIMEOUT_MS } from '../chat/native-user-questions.mjs';
import { readRecord } from '../lib/durable-records.mjs';
import { createCodexAdapter } from '../chat/adapters/codex.mjs';
import { createClaudeAdapter } from '../chat/adapters/claude.mjs';
import { buildSessionDisplayEvents } from '../chat/session-display-events.mjs';

assert.equal(QUESTION_TIMEOUT_MS, 300_000);
const attributedReply = '【飞书群消息｜发言人：嘉年】\n2';
assert.equal(nativeQuestionReplyText({ text: attributedReply, options: { sourceContext: { connector: 'feishu' } } }), '2');
assert.equal(nativeQuestionReplyText({ text: '【飞书群消息｜发言人：嘉年】\n请用中文\n保留例子', options: { sourceDelivery: { connector: 'feishu' } } }), '请用中文\n保留例子');
assert.equal(nativeQuestionReplyText({ text: attributedReply, options: {} }), attributedReply, 'Web text has no transport envelope');
assert.equal(nativeQuestionReplyText({ text: attributedReply, options: { recordedUserText: '自己的答案' } }), '自己的答案');
const root = await mkdtemp(join(tmpdir(), 'native-question-test-'));
const events = [], bus = new EventEmitter();
let clock = 1000, expire;
const broker = createNativeQuestionBroker({ directory: root, now: () => clock,
  setTimer: callback => { expire = callback; return callback; }, clearTimer: () => {},
  onEvent: event => { events.push(event); bus.emit(event.state, event); }, onError: error => { throw error; } });
const options = [{ label: 'Brief', description: 'Short result' }, { label: 'Detailed', description: 'All the detail' }];
const q = { id: 'format', header: 'Format', question: 'Which format?', options };
try {
  let pending = once(bus, 'pending');
  const answer = broker.ask({ protocol: 'codex', id: 'one', questions: [q] });
  await pending;
  const question = await readNativeQuestion(root);
  assert.equal(question.deadline, clock + 300_000);
  assert.match(events[0].content, /1\. Brief/);
  assert.match(events[0].content, /5 分钟.*第 1 项「Brief」/);
  assert.equal((await broker.answer({ id: 'user1', questionId: question.id, text: '2' })).mode, 'question_answer');
  assert.deepEqual({ ...(await answer).answers }, { format: ['Detailed'] });
  assert.equal((await readNativeQuestion(root)).state, 'resolved');
  assert.equal((await broker.answer({ id: 'late', questionId: question.id, text: '1' })).mode, 'question_expired');

  pending = once(bus, 'pending');
  const multiple = broker.ask({ protocol: 'claude', id: 'two', questions: [q, { ...q, question: 'Which sections?', multiSelect: true }] });
  await pending;
  const staleTimer = expire;
  pending = once(bus, 'pending');
  await broker.answer({ id: 'custom', questionId: (await readNativeQuestion(root)).id, text: '请用中文，保留代码例子' });
  await pending;
  staleTimer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await readNativeQuestion(root)).state, 'pending', 'a queued old timer cannot default the next question');
  await broker.answer({ id: 'multi', questionId: (await readNativeQuestion(root)).id, text: '1,2' });
  assert.deepEqual({ ...(await multiple).answers }, { 'Which format?': ['请用中文，保留代码例子'], 'Which sections?': ['Brief', 'Detailed'] });

  pending = once(bus, 'pending');
  const timed = broker.ask({ protocol: 'codex', id: 'three', questions: [q] });
  await pending;
  const deadline = (await readNativeQuestion(root)).deadline;
  clock = deadline;
  expire();
  const fallback = await timed;
  assert.deepEqual({ ...fallback.answers }, { format: ['Brief'] });
  assert.equal(fallback.resolutions[0].origin, 'timeout');
  assert.match(nativeQuestionAnswers(fallback).format[0], /Brief.*system timeout fallback; not a user response/);
  assert.ok(events.some(e => e.state === 'timeout' && e.origin === 'timeout' && /采用系统默认/.test(e.content)));
  const journals = await readdir(join(root, 'native-questions'));
  const records = await Promise.all(journals.map(name => readRecord(join(root, 'native-questions', name))));
  assert.equal(records.find(e => e.id === 'codex:three').resolutions[0].origin, 'timeout');
  assert.equal(records.find(e => e.id === 'codex:one').resolutions[0].inputId, 'user1');

  pending = once(bus, 'pending');
  const noOptions = broker.ask({ protocol: 'codex', id: 'four', questions: [{ ...q, options: null }] });
  await pending; clock = (await readNativeQuestion(root)).deadline; expire();
  assert.deepEqual({ ...(await noOptions).answers }, {});
  assert.match(events.at(-1).content, /超时未答/);

  assert.deepEqual(resolveQuestionAnswer({ options }, '123'), { values: ['123'], kind: 'custom' });
  assert.deepEqual(resolveQuestionAnswer({ options }, '2 个例子'), { values: ['2 个例子'], kind: 'custom' });
  assert.equal(resolveQuestionAnswer({ options }, '0').kind, 'custom');
  for (const createAdapter of [createCodexAdapter, createClaudeAdapter]) {
    const adapter = createAdapter();
    const questionEvents = adapter.parseLine(JSON.stringify(events[0]));
    assert.equal(questionEvents[0].messageKind, 'user_question');
    const history = [{ type: 'message', role: 'assistant', phase: 'commentary', content: 'Opening', seq: 1 },
      { type: 'tool_use', toolName: 'Question', seq: 2 }, ...questionEvents.map((e, i) => ({ ...e, seq: i + 3 }))];
    const visible = buildSessionDisplayEvents(history, { sessionRunning: true });
    assert.ok(visible.some(e => e.messageKind === 'user_question' && /1\. Brief/.test(e.content)), 'questions must show outside the collapsed process record');
    const ended = adapter.parseLine(JSON.stringify(events.find(e => e.questionId === events[0].questionId && e.state === 'answered')));
    const display = buildSessionDisplayEvents([...history, { type: 'message', role: 'user', content: '2', seq: 4 },
      { ...ended[0], seq: 5 }]);
    const questions = display.filter(e => e.messageKind === 'user_question');
    assert.equal(questions.length, 1, 'answers update the original question across user turns');
    assert.equal(questions[0].questionState, 'answered');
    assert.equal(questions[0].seq, 3);
    assert.equal(questions[0].messageUpdateSeq, 5);
    assert.match(questions[0].content, /Which format/);
  }
  pending = once(bus, 'pending');
  const cancelled = broker.ask({ protocol: 'codex', id: 'cancel', questions: [q] });
  await pending; await broker.cancel();
  assert.equal((await cancelled).cancelled, true);
  assert.equal((await readNativeQuestion(root)).state, 'cancelled');
  assert.equal(broker.pending, 0);
  console.log('native questions: numbered/custom/multiple answers, five-minute defaults, deadline races, durable origins and Web projection passed');
} finally { await broker.close(); await rm(root, { recursive: true, force: true }); }
