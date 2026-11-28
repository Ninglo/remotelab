// Explicitly extract technical facts. Free-form diagnostics (even if already
// redacted for administrators) can embed private task text, paths or secrets.
export function groupErrorLine(value) {
  const line = String(value || '').trim();
  if (/^Detached runner disappeared before writing a result$/i.test(line)
    || /^Sender lease expired without a receipt$/i.test(line)
    || /^Gate timed out after [1-9]\d{0,3}s$/.test(line)) return line;
  const gate = line.match(/^Gate exited with ([1-9]\d{0,2}): .*\b(query timed out; owned process group terminated)"?\}?$/i);
  if (gate) return `Gate exited with ${gate[1]}: ${gate[2]}`;
  const status = line.match(/(?:Main process exited, code=(?:exited|killed|dumped), status=\d+(?:\/[A-Z0-9]+)?|Failed with result '(?:exit-code|signal|timeout|core-dump|oom-kill|watchdog|resources|protocol|start-limit-hit)'\.)$/)?.[0];
  const code = line.match(/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|SQLITE_BUSY|ENOSPC|ENOENT|serverOverloaded)\b/i)?.[0];
  return status || code || '';
}
export function serviceExitSignal(line) {
  return String(line || '').match(/(?:^|\s)Main process exited, code=(?:killed|dumped), status=\d+\/([A-Z][A-Z0-9]{0,12})\s*$/)?.[1] || null;
}

export function originalLink(base, eventId) {
  if (!/^[a-f0-9]{64}$/.test(eventId || '')) return '';
  try {
    const url = new URL('/monitoring/recent-error-source', base);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    url.searchParams.set('id', eventId);
    return `[查看对应会话](${url.href})`;
  } catch { return ''; }
}
