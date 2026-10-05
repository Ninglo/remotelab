// Preserve the original question's place and wording. Later events are state
// changes, never a second question or another attention request.
export function projectNativeQuestionMessages(events = []) {
  const output = [], positions = new Map();
  for (const event of events) {
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
