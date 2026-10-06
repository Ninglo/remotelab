// A missing deadline means wait for the person. Do not coerce null to zero:
// the broker, HTTP admission and Connector must all accept the same question.
export const nativeQuestionDeadlineExpired = (deadline, now = Date.now()) =>
  Number.isFinite(deadline) && now >= deadline;

// Preserve the original question's place and wording. Later events are state
// changes, never a second question or another attention request.
export function projectNativeQuestionMessages(events = []) {
  const output = [], positions = new Map();
  const questionKeys = new Set(events.filter(event => event?.messageKind === 'user_question' && event.questionId)
    .map(event => `${event.runId || ''}:${event.questionId}`));
  for (const event of events) {
    // A control answer stays in raw history and native input, but its visible
    // acknowledgement belongs to the question. Typed replies keep their bubble;
    // an orphaned control record also stays visible if its question is absent.
    if (event?.role === 'user' && event.messageKind === 'native_question_answer'
        && questionKeys.has(`${event.nativeQuestionRunId || ''}:${event.nativeQuestionId}`)) continue;
    if (event?.messageKind !== 'user_question' || !event.nativeQuestion || !event.questionId) {
      output.push(event); continue;
    }
    const key = `${event.runId || ''}:${event.questionId}`;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, output.length); output.push(event); continue;
    }
    const original = output[position];
    output[position] = { ...original, questionState: event.questionState,
      answerOrigin: event.answerOrigin, questionAnswers: event.questionAnswers,
      questionStatusText: event.content, messageUpdateSeq: event.seq,
    };
  }
  return output;
}
