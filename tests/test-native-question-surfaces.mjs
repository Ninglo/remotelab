import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildNativeQuestionCard, sendNativeQuestionCard, handleNativeQuestionCardAction } from '../connectors/feishu/native-question-cards.mjs';
import { publishLiveAssistantReplies } from '../chat/native-final-publication.mjs';
import { buildSessionDisplayEvents } from '../chat/session-display-events.mjs';
import { processSourceDeliveryOnce } from '../scripts/feishu-connector.mjs';

const root = await mkdtemp(join(tmpdir(), 'question-surfaces-'));
const calls = [], identity = { sessionId: 'session', runId: 'run', questionId: 'question' };
const question = { id: 'question', state: 'pending', deadline: null,
  question: { question: '输出形式？', options: [{ label: '简短' }, { label: '详细' }] } };
const delivery = { id: 'delivery', sessionId: 'session', runId: 'run', nativeQuestion: question,
  target: { chatId: 'chat', chatType: 'group', messageId: 'inbound', replyInThread: true } };
const runtime = { config: { storageDir: root, sourceRouteId: 'bot' }, appClient: { im: { v1: { message: {
  reply: async input => { calls.push(['create', input]); return { code: 0, data: { message_id: 'original', thread_id: 'thread' } }; },
  patch: async input => { calls.push(['patch', input]); return { code: 0 }; },
  get: async () => ({ code: 0, data: { items: [{ message_id: 'original', chat_id: 'chat', msg_type: 'interactive' }] } }),
} } } } };
const rawAction = (value, fields = {}) => ({ header: { event_id: 'action-one' }, event: {
  context: { open_chat_id: 'chat', open_message_id: 'original' }, operator: { operator_id: { open_id: 'actor' } },
  action: { value: { namespace: 'native-question', ...identity, ...value }, form_value: fields },
} });
try {
  await sendNativeQuestionCard(runtime, delivery);
  assert.equal(calls[0][1].data.reply_in_thread, true);
  const first = JSON.parse(calls[0][1].data.content);
  const optionButtons = first.body.elements.flatMap(e => e.columns || []).flatMap(e => e.elements || []);
  assert.equal(optionButtons.filter(e => e.tag === 'button').length, 2);
  assert.equal(first.body.elements.find(e => e.tag === 'form').elements[0].expanded, false,
    'optional custom input does not occupy phone space before the user opens it');
  assert.ok(!first.header, 'the question does not need a second large title bar');
  assert.equal(first.body.elements.filter(e => e.tag === 'markdown').map(e => e.content).join('\n'),
    '输出形式？\n等你回答，不会超时自动选择。', 'labels appear on buttons rather than twice');
  const finiteCard = buildNativeQuestionCard(identity, { ...question, deadline: Date.now() + 300000 });
  assert.equal(finiteCard.body.elements.at(-1).content, '到期未答时默认选第 1 项。');
  const requests = [];
  const actionOptions = { authorize: async () => true, request: async (url, options) => {
    requests.push([url, options]); return { response: { ok: true } };
  } };
  assert.equal((await handleNativeQuestionCardAction(runtime, rawAction({ option: 2 }), actionOptions)).toast.type, 'success');
  assert.equal(requests[0][1].body.text, '2');
  assert.equal(requests[0][1].body.nativeQuestionId, 'question');
  assert.equal(requests[0][1].body.sourceContext.sender.openId, 'actor');
  assert.deepEqual(requests[0][1].body.sourceDelivery.target, delivery.target);
  await handleNativeQuestionCardAction(runtime, rawAction({ option: 2 }), actionOptions);
  assert.deepEqual(requests[0], requests[1], 'callback retry uses identical request identity and payload');
  await handleNativeQuestionCardAction(runtime, rawAction({}, { answer: '中文\n保留例子' }), actionOptions);
  assert.equal(requests.at(-1)[1].body.text, '中文\n保留例子');
  const denied = await handleNativeQuestionCardAction(runtime, rawAction({ option: 1 }), { ...actionOptions, authorize: async () => false });
  assert.equal(denied.toast.type, 'error');
  const tampered = rawAction({ option: 1 }); tampered.event.context.open_chat_id = 'another-chat';
  assert.equal((await handleNativeQuestionCardAction(runtime, tampered, actionOptions)).toast.type, 'error');
  assert.equal(requests.length, 3, 'denied or tampered callbacks submit nothing');
  const timeout = { ...delivery, id: 'timeout', nativeQuestion: { ...question, state: 'timeout', origin: 'timeout',
    answers: ['简短'], statusText: '未收到回复，已采用系统默认「简短」。' } };
  await sendNativeQuestionCard(runtime, timeout);
  assert.deepEqual(calls.map(call => call[0]), ['create', 'patch']);
  assert.equal(calls[1][1].path.message_id, 'original');
  assert.ok(!JSON.stringify(JSON.parse(calls[1][1].data.content)).includes('behaviors'), 'ended card cannot submit answers');
  const endedCard = JSON.parse(calls[1][1].data.content);
  assert.equal(endedCard.body.elements[0].content, timeout.nativeQuestion.statusText);
  assert.equal(endedCard.body.elements[1].expanded, false, 'ended questions keep context out of the reading path');
  await sendNativeQuestionCard({ ...runtime }, timeout);
  await sendNativeQuestionCard(runtime, delivery);
  assert.equal(calls.length, 2, 'restart/replay cannot resend or reopen the question');
  assert.equal((await handleNativeQuestionCardAction(runtime, rawAction({ option: 1 }), actionOptions)).toast.type, 'error');
  assert.equal(requests.length, 3, 'expired buttons do not launch unrelated work');
  assert.equal((await sendNativeQuestionCard(runtime, { ...timeout, runId: 'unknown' })).skipped, true);
  assert.equal((await sendNativeQuestionCard(runtime, { ...delivery, runId: 'old', nativeQuestion: { ...question, deadline: Date.now() - 1 } })).skipped, true);
  let uncertainCreates = 0;
  const uncertainRuntime = { ...runtime, config: { ...runtime.config, storageDir: join(root, 'uncertain') },
    appClient: { im: { v1: { message: { ...runtime.appClient.im.v1.message,
      reply: async () => { uncertainCreates++; throw new Error('lost transport acknowledgement'); },
    } } } } };
  await assert.rejects(sendNativeQuestionCard(uncertainRuntime, delivery), /lost transport/);
  await assert.rejects(sendNativeQuestionCard(uncertainRuntime, delivery), /outcome is unknown/);
  assert.equal(uncertainCreates, 1, 'an unknown create cannot send another card');
  let rejectedCreates = 0;
  const rejectedRuntime = { ...runtime, config: { ...runtime.config, storageDir: join(root, 'rejected') },
    appClient: { im: { v1: { message: { ...runtime.appClient.im.v1.message,
      reply: async () => ++rejectedCreates === 1 ? { code: 99991672, msg: 'missing scope' }
        : { code: 0, data: { message_id: 'original' } },
    } } } } };
  await assert.rejects(sendNativeQuestionCard(rejectedRuntime, delivery), /missing scope/);
  await sendNativeQuestionCard(rejectedRuntime, delivery);
  assert.equal(rejectedCreates, 2, 'a definite rejection permits a corrected, explicitly retried delivery');

  for (const [target, method, threaded] of [
    [{ chatType: 'group', conversationKind: 'main', messageId: 'source' }, 'reply', false],
    [{ chatType: 'group' }, 'create', undefined],
    [{ chatType: 'p2p', conversationKind: 'main', messageId: 'source' }, 'create', undefined],
  ]) {
    const sent = [];
    const app = { ...runtime.appClient.im.v1.message,
      reply: async input => { sent.push(['reply', input]); return { code: 0, data: { message_id: 'original' } }; },
      create: async input => { sent.push(['create', input]); return { code: 0, data: { message_id: 'original' } }; },
    };
    await sendNativeQuestionCard({ ...runtime, appClient: { im: { v1: { message: app } } } }, {
      ...delivery, runId: `matrix-${target.chatType}-${method}`,
      target: { chatId: 'chat', ...target },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], method);
    assert.equal(sent[0][1].data.reply_in_thread, threaded);
    if (method === 'reply') assert.equal(sent[0][1].path.message_id, 'source');
  }

  const multi = buildNativeQuestionCard(identity, { ...question, question: { ...question.question, multiSelect: true } });
  assert.equal(multi.body.elements.find(e => e.tag === 'form').elements[0].tag, 'multi_select_static');
  assert.equal(multi.body.elements.find(e => e.tag === 'form').elements.length, 2,
    'multi-select uses its own submit without requiring custom input');
  const freeText = buildNativeQuestionCard(identity, { ...question, question: { question: '填写说明', options: [] } });
  assert.equal(freeText.body.elements.find(e => e.tag === 'form').elements[0].tag, 'input',
    'free-text-only questions keep the required input visible');

  const pending = { seq: 2, type: 'message', role: 'assistant', runId: 'run', phase: 'commentary',
    content: '输出形式？\n1. 简短\n2. 详细', messageKind: 'user_question', providerMessageId: 'question:pending',
    nativeQuestion: question.question, questionId: 'question', questionState: 'pending', questionDeadline: question.deadline };
  const ended = { ...pending, seq: 4, providerMessageId: 'question:timeout', questionState: 'timeout', answerOrigin: 'timeout',
    questionAnswers: ['简短'], content: timeout.nativeQuestion.statusText };
  const history = [{ seq: 1, type: 'message', role: 'user', content: '处理一下' }, pending,
    { seq: 3, type: 'tool_use', toolName: 'work' }, ended];
  const visible = buildSessionDisplayEvents(history, { exposeWorkboard: true });
  const questions = visible.filter(e => e.messageKind === 'user_question');
  assert.equal(questions.length, 1); assert.equal(questions[0].seq, 2);
  assert.equal(questions[0].messageUpdateSeq, 4); assert.equal(questions[0].answerOrigin, 'timeout');
  assert.equal(questions[0].content, pending.content);
  const controlAnswer = { seq: 3, type: 'message', role: 'user', content: '1', messageKind: 'native_question_answer',
    nativeQuestionId: pending.questionId, nativeQuestionRunId: pending.runId };
  const controlledHistory = [history[0], pending, controlAnswer, ended];
  assert.equal(buildSessionDisplayEvents(controlledHistory).filter(e => e.role === 'user').length, 1,
    'a control answer is acknowledged by the question, not a second user bubble');
  assert.equal(controlledHistory[2], controlAnswer, 'display projection retains the raw control record');
  assert.ok(buildSessionDisplayEvents([{ ...controlAnswer, nativeQuestionRunId: 'other-run' }, pending]).some(e => e.content === '1'),
    'a question in another run cannot swallow an orphaned answer');
  assert.ok(buildSessionDisplayEvents([history[0], pending, { ...controlAnswer, messageKind: undefined }, ended]).some(e => e.role === 'user' && e.content === '1'),
    'a typed reply retains its ordinary bubble');
  let record = { key: 'key', runId: 'run', options: {}, deliveries: [] };
  const options = { store: { get: async () => record, mutate: async (_key, fn) => { record = fn(record); } },
    plan: { connector: 'feishu', sourceRouteId: 'bot', target: delivery.target } };
  await publishLiveAssistantReplies(record, history, options);
  assert.deepEqual(record.deliveries.map(d => d.nativeQuestion.state), ['pending', 'timeout']);
  await publishLiveAssistantReplies(record, history, options);
  assert.equal(record.deliveries.length, 2, 'recovery queues each state only once');

  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.textContent = ''; }
    appendChild(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this; this.children.push(child); return child;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const optionRows = node => descendants(node).filter(child => child.className?.startsWith('native-question-option') && child.className !== 'native-question-options');
  const statusOf = node => descendants(node).find(child => child.className === 'native-question-status');
  const submissions = [];
  const context = { document: { createElement: tag => new Element(tag) }, currentSessionId: 'session', shareSnapshotMode: false,
    createRequestId: () => 'web-answer', appendMessageTimestamp() {}, refreshCurrentSession: async () => {},
    fetchJsonOrRedirect: async (url, opts) => { submissions.push([url, JSON.parse(opts.body)]); } };
  vm.createContext(context);
  vm.runInContext(await readFile(new URL('../static/chat/native-question-ui.js', import.meta.url), 'utf8'), context);
  let panel = context.renderNativeQuestionMessage(new Element('div'), pending);
  assert.equal(statusOf(panel).textContent, '待你选择');
  assert.ok(!panel.children.some(c => c.className?.includes('native-question-deadline')),
    'ordinary questions do not repeat a no-timeout footer');
  assert.equal(statusOf(panel).attributes['aria-live'], 'polite');
  assert.equal(panel.children.find(c => c.tag === 'details').children[0].textContent, '填写其他答案');
  optionRows(panel)[1].listeners.click();
  assert.equal(statusOf(panel).textContent, '正在提交：详细…');
  optionRows(panel)[0].listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submissions[0][1], { requestId: 'web-answer', nativeQuestionId: 'question', nativeQuestionAnswerSource: 'control', text: '2' });
  assert.equal(submissions.length, 1, 'in-flight clicks cannot submit a second answer');
  assert.equal(statusOf(panel).textContent, '已选择');
  assert.equal(optionRows(panel).find(c => c.className.includes('is-selected')).attributes['aria-pressed'], 'true');
  assert.equal(descendants(panel).find(c => c.className === 'native-question-answer-body').children[0].children.length, 1,
    'the selected option stays visible while the other option is folded');
  assert.ok(optionRows(panel).every(c => c.disabled));
  panel = context.renderNativeQuestionMessage(new Element('div'), pending);
  assert.equal(statusOf(panel).textContent, '已选择', 'a stale pending refresh retains the accepted answer');
  assert.ok(!panel.children.some(c => c.tag === 'form'));
  panel = context.renderNativeQuestionMessage(new Element('div'), { ...pending, questionState: 'answered', questionAnswers: ['详细'] });
  assert.equal(statusOf(panel).textContent, '已选择', 'canonical recovery shows the selected answer');
  assert.equal(optionRows(panel)[0].children.at(-1).textContent, '详细');
  panel = context.renderNativeQuestionMessage(new Element('div'), { ...pending, questionId: 'multiple', nativeQuestion: { ...pending.nativeQuestion, multiSelect: true } });
  optionRows(panel).forEach(c => { c.children[0].checked = true; });
  panel.children.find(c => c.tag === 'button').listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(submissions.at(-1)[1].text, '1,2');
  assert.equal(statusOf(panel).textContent, '已选择');
  panel = context.renderNativeQuestionMessage(new Element('div'), { ...pending, questionId: 'multiple', questionState: 'answered',
    questionAnswers: ['简短', '详细'], nativeQuestion: { ...pending.nativeQuestion, multiSelect: true } });
  assert.ok(optionRows(panel).every(c => c.children[0].checked), 'recovered multi-select shows the answered checkboxes');
  panel = context.renderNativeQuestionMessage(new Element('div'), { ...pending, questionId: 'custom' });
  const form = descendants(panel).find(c => c.tag === 'form');
  form.children[0].value = '自己的答案'; form.listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(submissions.at(-1)[1].text, '自己的答案');
  assert.equal(statusOf(panel).textContent, '已提交');
  assert.equal(descendants(panel).find(c => c.className === 'native-question-answer').textContent, '自己的答案');
  panel = context.renderNativeQuestionMessage(new Element('div'), { ...pending, questionId: 'free-text', nativeQuestion: { question: '说明原因', options: [] } });
  assert.equal(statusOf(panel).textContent, '待你填写');
  assert.ok(panel.children.some(c => c.tag === 'form'), 'required free text stays directly visible');
  panel = context.renderNativeQuestionMessage(new Element('div'), questions[0]);
  assert.ok(optionRows(panel).every(c => c.disabled));
  assert.equal(statusOf(panel).textContent, '已采用系统默认：简短（非你的选择）');
  context.refreshCurrentSession = async () => { throw new Error('Refresh offline'); };
  panel = context.renderNativeQuestionMessage(new Element('div'), { ...pending, questionId: 'refresh-failed' });
  optionRows(panel)[0].listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(statusOf(panel).textContent, '已选择', 'accepted submission survives a failed refresh');
  assert.ok(optionRows(panel).every(c => c.disabled));
  context.fetchJsonOrRedirect = async (url, opts) => { submissions.push([url, JSON.parse(opts.body)]); throw new Error('Network offline'); };
  panel = context.renderNativeQuestionMessage(new Element('div'), { ...pending, questionId: 'retry' });
  optionRows(panel)[0].listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(statusOf(panel).textContent.includes('提交未获确认'));
  assert.ok(optionRows(panel).every(c => !c.disabled));
  const firstRetry = submissions.at(-1);
  optionRows(panel)[1].listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(submissions.at(-1), firstRetry, 'uncertain submission cannot switch to another answer');
  optionRows(panel)[0].listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submissions.at(-1), firstRetry, 'retry retains its original identity and payload');
  context.shareSnapshotMode = true;
  panel = context.renderNativeQuestionMessage(new Element('div'), pending);
  assert.ok(optionRows(panel).every(c => c.disabled));
  assert.equal(statusOf(panel).textContent, '待回答（只读）');
  const workerRuntime = { ...runtime, config: { ...runtime.config, storageDir: join(root, 'worker') } };
  const workerCalls = calls.length;
  let workerDelivery = delivery;
  const workerOptions = { sendFeishuText: async () => { throw new Error('Question updates must not send a text reminder'); },
    requestRemoteLab: async path => ({ response: { ok: true }, json: path === '/api/source-deliveries/claim'
      ? { claim: { leaseId: `lease-${workerDelivery.id}`, delivery: workerDelivery } }
      : { delivery: { state: 'delivered' } } }) };
  await processSourceDeliveryOnce(workerRuntime, workerOptions);
  workerDelivery = timeout;
  await processSourceDeliveryOnce(workerRuntime, workerOptions);
  assert.deepEqual(calls.slice(workerCalls).map(c => c[0]), ['create', 'patch'],
    'the actual Connector worker routes questions to one interactive card and updates it in place');
  console.log('native question surfaces: original-card updates, no timeout resend, durable replay, actor/target checks, expired controls, Web single/multiple/custom answers passed');
} finally { await rm(root, { recursive: true, force: true }); }
