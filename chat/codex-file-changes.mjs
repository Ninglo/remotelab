import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { findCodexSessionLog } from './codex-session-metrics.mjs';

// Read newly appended provider-log bytes only when a file operation completes.
// No workspace reads, git commands, watchers or periodic snapshots.
export function createCodexFileChangeCapture({ startedAt, locateLog = findCodexSessionLog } = {}) {
  const startMs = Date.parse(startedAt || '');
  let thread = '', offset = 0, logPath = '', identity = '', blocked = false;
  const pending = [];
  const completed = new Map();
  async function readNewRecords(threadId) {
    if (!logPath) logPath = await locateLog(threadId);
    if (!logPath) return;
    const info = await stat(logPath);
    const nextIdentity = `${info.dev}:${info.ino}`;
    if ((identity && identity !== nextIdentity) || info.size < offset) {
      blocked = true;
      return;
    }
    identity = nextIdentity;
    if (info.size === offset) return;
    let remainder = '';
    for await (const chunk of createReadStream(logPath, { start: offset, end: info.size - 1, encoding: 'utf8' })) {
      remainder += chunk;
      let end;
      while ((end = remainder.indexOf('\n')) !== -1) {
        const line = remainder.slice(0, end);
        remainder = remainder.slice(end + 1);
        offset += Buffer.byteLength(line + '\n');
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        const payload = record?.payload;
        if (record.type !== 'event_msg' || payload?.type !== 'item_completed'
          || payload.thread_id !== threadId || payload.item?.type !== 'FileChange') continue;
        const timestamp = Date.parse(record.timestamp || '');
        if (!Number.isFinite(timestamp) || timestamp < startMs) continue;
        pending.push(payload.item);
      }
    }
    // Partial final JSONL records are reread next time.
  }
  return {
    // Called before a resumed provider starts: skip its existing history without
    // reading it. New threads (and explicit historical replay) start at byte 0.
    async prepare(threadId) {
      if (!/^[\w-]+$/.test(threadId || '')) return;
      thread = threadId;
      try {
        logPath = await locateLog(threadId) || '';
        if (!logPath) return;
        const info = await stat(logPath);
        offset = info.size;
        identity = `${info.dev}:${info.ino}`;
      } catch (error) {
        blocked = true;
        console.warn('[file-diff] Native capture initialization unavailable:', error.code || error.name);
      }
    },
    async enrich(event, threadId) {
      if (event?.type !== 'item.completed' || event.item?.type !== 'file_change') return event;
      if (!Number.isFinite(startMs) || !/^[\w-]+$/.test(threadId || '')) return event;
      if (thread && thread !== threadId) {
        offset = 0; logPath = ''; identity = ''; blocked = false;
        pending.length = 0; completed.clear();
      }
      thread = threadId;
      const item = event.item;
      if (completed.has(item.id)) return completed.get(item.id);
      if (blocked) return event;
      try {
        for (let attempt = 0; attempt < 3 && !pending.length; attempt++) {
          if (attempt) await new Promise(resolve => setTimeout(resolve, 25));
          await readNewRecords(threadId);
        }
        const native = pending.shift();
        const signature = changes => changes.map(([path, kind]) => `${path}\0${kind}`).sort().join('\n');
        const sameFiles = signature(Object.entries(native?.changes || {}).map(([path, change]) => [path, change.type]))
          === signature((item.changes || []).map(change => [change.path, change.kind]));
        // Stdout uses item_N; native logs use exec_UUID. Pair completion ORDER
        // within this run/thread, checking the full path/kind set and status.
        // Never search ahead by path: repeated edits would become ambiguous.
        if (!native || !sameFiles || native.status !== item.status || blocked) {
          blocked = true;
          return event;
        }
        const enriched = { ...event, item: { ...item, changes: item.changes.map(change => {
          if (typeof change.diff === 'string' || typeof change.patch === 'string') return change;
          const detail = native.changes[change.path];
          const diff = nativeFileDiff(detail);
          return { ...change, ...(diff !== null ? {
            diff, diffSource: 'codex_session', nativeChangeId: native.id,
            ...(detail.move_path ? { previousPath: change.path, path: detail.move_path } : {}),
          } : (detail.content?.includes('\0') ? { diffUnavailableReason: 'binary' } : {})) };
        }) } };
        completed.clear(); // Only the immediately repeated completion needs replay protection.
        completed.set(item.id, enriched);
        return enriched;
      } catch (error) {
        blocked = true;
        console.warn('[file-diff] Native capture unavailable:', error.code || error.name);
        return event;
      }
    },
  };
}

export function nativeFileDiff(change) {
  if (typeof change?.unified_diff === 'string') return change.unified_diff;
  if (typeof change?.diff === 'string') return change.diff;
  if (typeof change?.content !== 'string' || !['add', 'delete'].includes(change.type)) return null;
  if (change.content.includes('\0')) return null;
  const lines = change.content.split('\n');
  const finalNewline = lines.at(-1) === '';
  if (finalNewline) lines.pop();
  if (!change.content) return '';
  const added = change.type === 'add';
  return `@@ -${added ? '0,0' : `1,${lines.length}`} +${added ? `1,${lines.length}` : '0,0'} @@\n`
    + lines.map(line => (added ? '+' : '-') + line + '\n').join('')
    + (finalNewline ? '' : '\\ No newline at end of file\n');
}
