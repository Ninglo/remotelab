import { candidateWorkFromSessions } from './work-awareness-relevance.mjs';

// Search results point to originals. Do not repeat eight historical results or
// unrelated work from the current Session in a focused lookup.
export function workContextPointer(work) {
  const latest = work.results?.at(-1);
  return { ...work, results: latest ? [{ ...latest,
    result: String(latest.result || '').slice(0, 600),
    resultTruncated: String(latest.result || '').length > 600,
  }] : [], authority: 'reference-only' };
}

export function focusedCurrentWork(session, scope) {
  const works = session.workAwareness?.works || [];
  const query = scope.query || works.filter(work => work.status === 'active').at(-1)?.goal
    || session.workSummary?.goal || '';
  const matches = candidateWorkFromSessions([session], { ...scope, sessionId: '', query });
  return { works: matches.map(workContextPointer),
    omittedWorkCount: works.filter(work => !matches.some(match => match.id === work.id)).length,
    boundary: 'Matched current work only; omitted records remain available through the full context view.' };
}
