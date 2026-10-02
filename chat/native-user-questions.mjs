import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readRecord, serialQueue, writeDurableJson } from '../lib/durable-records.mjs';
import { messageEvent } from './normalizer.mjs';

export const QUESTION_TIMEOUT_MS = 5 * 60_000;
const currentPath = directory => join(directory, 'native-question.json');
export const readNativeQuestion = directory => readRecord(currentPath(directory));

// Feishu adds a speaker envelope to the conversation transcript. Keep that
// attribution in history, but return only the user's reply to the native tool.
export function nativeQuestionReplyText(record) {
  const recorded = record.options?.recordedUserText;
  const text = typeof recorded === 'string' && recorded.trim() ? recorded : record.text;
  const feishu = record.options?.sourceContext?.connector === 'feishu'
    || record.options?.sourceDelivery?.connector === 'feishu';
  return feishu ? text.replace(/^【飞书群消息｜发言人：[^\r\n]*】\r?\n/, '') : text;
}

export function normalizeNativeQuestions(questions, protocol) {
  if (!Array.isArray(questions)) return [];
  return questions.filter(q => q && typeof q.question === 'string' && q.question.trim()).map(q => ({
    key: protocol === 'codex' ? q.id : q.question,
    question: q.question,
    header: q.header || '',
    secret: q.isSecret === true,
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).filter(o => typeof o?.label === 'string' && o.label.trim())
      .map(o => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })),
  })).filter(q => typeof q.key === 'string' && q.key);
}

// Only complete, in-range numeric shortcuts select options. All other text is
// returned verbatim as a custom answer, including an out-of-range number.
export function resolveQuestionAnswer(question, text) {
  const raw = String(text).trim();
  const pattern = question.multiSelect ? /^\d+(?:[\s,，]+\d+)*$/ : /^\d+$/;
  if (pattern.test(raw)) {
    const indices = [...new Set(raw.split(/[\s,，]+/).map(Number))];
    if (indices.every(i => i >= 1 && i <= question.options.length)) {
      return { values: indices.map(i => question.options[i - 1].label), kind: 'option' };
    }
  }
  return { values: [raw], kind: 'custom' };
}

export function nativeQuestionEvent(obj) {
  if (obj?.type !== 'remotelab.user_question' || typeof obj.content !== 'string') return null;
  return messageEvent('assistant', obj.content, [], {
    phase: 'commentary', messageKind: 'user_question', source: 'native_question',
    providerMessageId: obj.messageId, questionId: obj.questionId,
    questionState: obj.state, answerOrigin: obj.origin,
  });
}

export function nativeQuestionAnswers(result) {
  return Object.fromEntries(Object.entries(result.answers).map(([key, values]) => [key,
    result.resolutions?.find(r => r.key === key)?.origin === 'timeout'
      ? values.map(value => `${value} [system timeout fallback; not a user response]`) : values,
  ]));
}

// The detached native host owns questions, their deadline and native replies.
// Controller restarts only re-read the durable current-question pointer; they
// neither reset the deadline nor repeat a native tool response.
export function createNativeQuestionBroker({ directory, onEvent, onError = () => {}, onIdle = () => {},
  timeoutMs = QUESTION_TIMEOUT_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const serial = serialQueue();
  const queue = [];
  let active = null, timer = null, closed = false;
  const journalPath = entry => join(directory, 'native-questions', `${createHash('sha256').update(entry.id).digest('hex').slice(0, 32)}.json`);
  const emit = (entry, state, content, origin = '') => onEvent({
    type: 'remotelab.user_question', messageId: `${entry.id}:${entry.index}:${state}`,
    questionId: `${entry.id}:${entry.index}`, state, origin, content,
  });
  const save = entry => writeDurableJson(journalPath(entry), {
    id: entry.id, protocol: entry.protocol, state: entry.state, index: entry.index,
    openedAt: entry.openedAt, deadline: entry.deadline, questions: entry.questions,
    answers: entry.answers, resolutions: entry.resolutions,
  });
  function publicQuestion(entry) {
    const q = entry.questions[entry.index];
    const minutes = timeoutMs / 60_000;
    const options = q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? `：${o.description}` : ''}`);
    return [entry.questions.length > 1 ? `问题 ${entry.index + 1}/${entry.questions.length}：${q.question}` : q.question,
      ...options, '', q.multiSelect ? '回复编号选择；多选可回复 1,2。其他文字作为自定义回答。' : '回复 1、2、3 等编号选择；其他文字作为自定义回答。',
      q.options.length ? `${minutes} 分钟内未回复，将超时自动选择第 1 项「${q.options[0].label}」。`
        : `${minutes} 分钟内未回复，将按“超时未答”返回，让 AI 继续处理。`].join('\n');
  }
  async function showNext() {
    if (closed || active) return;
    active = queue.shift() || null;
    if (!active) return;
    await showQuestion();
  }
  async function showQuestion() {
    const entry = active;
    clearTimer(timer);
    while (entry.index < entry.questions.length && entry.questions[entry.index].secret) {
      entry.resolutions.push({ key: entry.questions[entry.index].key, origin: 'unsupported_secret', at: now() });
      emit(entry, 'unanswered', '这道问题需要私密输入，普通聊天不接收；已返回未答状态。');
      entry.index++;
    }
    if (entry.index >= entry.questions.length) { await complete(); return; }
    entry.state = 'pending';
    entry.deadline = now() + timeoutMs;
    await save(entry);
    await writeDurableJson(currentPath(directory), { id: `${entry.id}:${entry.index}`, state: 'pending', deadline: entry.deadline });
    emit(entry, 'pending', publicQuestion(entry));
    const questionId = `${entry.id}:${entry.index}`;
    const deadline = entry.deadline;
    timer = setTimer(() => void serial(() => {
      // Clearing a timer cannot remove a callback already queued behind a user
      // reply. That callback belongs to the old question, never the next one.
      if (active && `${active.id}:${active.index}` === questionId && now() >= deadline) return answerCurrent(null, 'timeout');
    }).catch(onError), Math.max(0, deadline - now()));
  }
  async function complete() {
    const entry = active;
    clearTimer(timer);
    entry.state = 'resolved';
    await save(entry);
    await writeDurableJson(currentPath(directory), { state: 'resolved', id: `${entry.id}:${entry.index}`, deadline: null });
    active = null;
    entry.resolve({ answers: entry.answers, resolutions: entry.resolutions });
    await showNext();
    onIdle();
  }
  async function answerCurrent(input, origin) {
    const entry = active;
    if (!entry) return null;
    const q = entry.questions[entry.index];
    const resolved = origin === 'timeout' ? { values: q.options.length ? [q.options[0].label] : [], kind: 'default' }
      : resolveQuestionAnswer(q, input.text);
    if (resolved.values.length) entry.answers[q.key] = resolved.values;
    entry.resolutions.push({ key: q.key, origin, kind: resolved.kind, values: resolved.values,
      at: now(), ...(input ? { inputId: input.id } : {}) });
    if (origin === 'timeout') emit(entry, 'timeout', q.options.length
      ? `问题「${q.question}」5 分钟未收到回复，已超时自动选择「${q.options[0].label}」，继续处理。`
      : `问题「${q.question}」5 分钟未收到回复，已按“超时未答”返回，继续处理。`, origin);
    const questionId = `${entry.id}:${entry.index}`;
    entry.index++;
    await showQuestion();
    return { accepted: true, id: input?.id, mode: 'question_answer', questionId, origin };
  }
  return {
    get pending() { return queue.length + Number(Boolean(active)); },
    ask({ id = randomUUID(), protocol, questions }) {
      if (closed) return Promise.reject(new Error('Native question host closed'));
      const normalized = normalizeNativeQuestions(questions, protocol);
      if (!normalized.length) return Promise.resolve({ answers: {}, resolutions: [] });
      return new Promise((resolve, reject) => {
        queue.push({ id: `${protocol}:${id}`, protocol, questions: normalized, index: 0,
          state: 'queued', openedAt: now(), answers: Object.create(null), resolutions: [], resolve, reject });
        void serial(showNext).catch(error => { reject(error); onError(error); });
      });
    },
    answer(input) {
      if (!input.questionId) return Promise.resolve(null);
      return serial(async () => {
        if (!active || input.questionId !== `${active.id}:${active.index}` || now() >= active.deadline) {
          if (active && now() >= active.deadline) await answerCurrent(null, 'timeout');
          onEvent({ type: 'remotelab.user_question', messageId: `question-expired:${input.id}`,
            questionId: input.questionId, state: 'expired', origin: 'user',
            content: '这条回答对应的问题已结束，未应用这条回答。需要修改时，请直接说明新的选择。' });
          return { accepted: true, id: input.id, mode: 'question_expired', questionId: input.questionId };
        }
        return answerCurrent(input, 'user');
      });
    },
    async cancel() {
      closed = true;
      clearTimer(timer);
      await serial(async () => {
        for (const entry of [active, ...queue].filter(Boolean)) {
          entry.state = 'cancelled'; await save(entry);
          entry.resolve({ cancelled: true, answers: {}, resolutions: entry.resolutions });
        }
        if (active) await writeDurableJson(currentPath(directory), { state: 'cancelled', id: `${active.id}:${active.index}` });
        active = null; queue.length = 0;
      });
    },
    async close() {
      closed = true;
      clearTimer(timer);
      await serial(async () => {
        for (const entry of [active, ...queue].filter(Boolean)) entry.reject(new Error('Native question host closed'));
        queue.length = 0;
        if (active) {
          active.state = 'cancelled'; await save(active);
          await writeDurableJson(currentPath(directory), { state: 'cancelled', id: `${active.id}:${active.index}` });
          active = null;
        }
      });
    },
  };
}
