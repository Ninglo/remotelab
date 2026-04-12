export function parseSessionGetRoute(pathname) {
  if (pathname === '/api/sessions') {
    return { kind: 'list' };
  }

  if (pathname === '/api/sessions/archived') {
    return { kind: 'archived-list' };
  }

  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'sessions') {
    return null;
  }

  const sessionId = parts[2];
  if (!sessionId) {
    return null;
  }

  if (parts.length === 3) {
    return { kind: 'detail', sessionId };
  }

  if (parts.length === 4 && parts[3] === 'events') {
    return { kind: 'events', sessionId };
  }

  if (parts.length === 4 && parts[3] === 'source-context') {
    return { kind: 'source-context', sessionId };
  }

  if (parts.length === 5 && parts[3] === 'responses' && parts[4]) {
    return { kind: 'response', sessionId, responseId: decodeURIComponent(parts[4]) };
  }

  if (parts.length === 6 && parts[3] === 'events' && parts[4] === 'blocks') {
    const match = /^([1-9]\d*)-([1-9]\d*)$/.exec(parts[5] || '');
    if (!match) return null;
    const startSeq = parseInt(match[1], 10);
    const endSeq = parseInt(match[2], 10);
    if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq) || endSeq < startSeq) {
      return null;
    }
    return { kind: 'event-block', sessionId, startSeq, endSeq };
  }

  if (parts.length === 6 && parts[3] === 'events' && parts[5] === 'body') {
    const seq = parseInt(parts[4], 10);
    if (!Number.isInteger(seq) || seq < 1) return null;
    return { kind: 'event-body', sessionId, seq };
  }

  return null;
}
