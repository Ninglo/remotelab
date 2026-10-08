import { appendFile, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';

export const CLIENT_USAGE_EVENTS = new Set(['page_enter', 'session_open', 'page_visibility', 'ui_action', 'content_presented', 'artifact_open']);
const SERVER_EVENTS = new Set(['message_submitted', 'request_state', 'run_state', 'question_state', 'tool_started', 'tool_finished',
  'artifact_generated', 'artifact_registered', 'artifact_attached', 'web_published', 'delivery_state', 'artifact_access_requested', 'session_created', 'session_linked']);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : '';
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,64}$/.test(value) ? value : '';
const CLIENT_TOKENS = {
  page: new Set(['sessions', 'tasks', 'settings']),
  action: new Set(['stop', 'send', 'new_session', 'create_automation', 'monitor_overview', 'monitor_automations', 'monitor_usage', 'open', 'download', 'preview']),
  feature: new Set(['workbench']),
  state: new Set(['foreground', 'background', 'leave', 'pending', 'answered', 'unanswered', 'timeout', 'cancelled', 'expired']),
  kind: new Set(['question', 'final', 'reply', 'web', 'image', 'file', 'document', 'table', 'audio', 'video']),
  entry: new Set(['session_link', 'default', 'navigation', 'foreground']),
};
export const usageKey = value => createHash('sha256').update(`usage-v1:${value}`).digest('hex');
export function artifactKind(mime = '') {
  mime = typeof mime === 'string' ? mime : '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'text/html') return 'web';
  if (/spreadsheet|excel|csv/.test(mime)) return 'table';
  if (/pdf|word|document|markdown|text\/plain/.test(mime)) return 'document';
  return 'file';
}

// Only these fields reach the ledger. Never forward a tool's arguments, message
// text, answers, filenames, URLs, IP address or arbitrary client properties.
export function normalizeUsageEvent(input, { personId = '', client = false, now = Date.now() } = {}) {
  if (!(client ? CLIENT_USAGE_EVENTS : SERVER_EVENTS).has(input?.event)) return null;
  const eventId = identifier(input.eventId);
  if (!eventId) return null;
  const rawTime = Number(input.timestamp);
  const timestamp = Number.isFinite(rawTime) && rawTime <= now + 60_000
    && (!client || rawTime >= now - 86_400_000) ? rawTime : now;
  const event = { schemaVersion: 1, eventId, event: input.event, timestamp, ingestedAt: now,
    surface: client ? 'web' : ['web', 'feishu', 'agent', 'automation', 'runtime'].includes(input.surface) ? input.surface : 'runtime',
    actorKind: client ? 'human' : ['human', 'agent', 'automation', 'system'].includes(input.actorKind) ? input.actorKind : 'system' };
  if (personId) event.personHash = usageKey(`person:${personId}`);
  for (const key of ['sessionId', 'requestId', 'runId', 'visitId', 'parentSessionId', 'objectId', 'originObjectId', 'automationId', 'questionId', 'toolCallId']) {
    const value = identifier(input[key]); if (value) event[key] = value;
  }
  for (const key of ['page', 'action', 'feature', 'state', 'kind', 'tool', 'origin', 'entry', 'conversationKey', 'operation']) {
    const value = token(input[key]);
    if (value && (!client || CLIENT_TOKENS[key]?.has(value))) event[key] = value;
  }
  for (const key of ['historySeq', 'sizeBytes', 'durationMs', 'deadline']) {
    const value = input[key]; if (Number.isFinite(value) && value >= 0) event[key] = value;
  }
  return event;
}

export function createUsageEventStore({ directory = join(CONFIG_DIR, 'usage-events'), maxPending = 2048 } = {}) {
  const activatedAt = Date.now();
  const collectionSince = readFile(join(directory, 'collection.json'), 'utf8')
    .then(raw => Date.parse(JSON.parse(raw).startedAt) || activatedAt)
    .catch(() => activatedAt);
  let tail = Promise.resolve(), pending = 0, dropped = 0, failures = 0, ready = false, warned = false;
  const seen = new Map(), queued = new Set(), admissions = new Set();
  const remember = id => { seen.set(id, true); if (seen.size > 50_000) seen.delete(seen.keys().next().value); };
  async function init() {
    if (ready) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try { await writeFile(join(directory, 'collection.json'), JSON.stringify({ schemaVersion: 1, startedAt: new Date(activatedAt).toISOString() }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    ready = true;
  }
  function record(events, context = {}) {
    const admission = collectionSince.then(since => {
      const valid = [...new Map((Array.isArray(events) ? events : [events])
        .map(value => normalizeUsageEvent(value, context))
        .filter(event => event && event.timestamp >= since && !seen.has(event.eventId) && !queued.has(event.eventId))
        .map(event => [event.eventId, event])).values()];
      if (!valid.length) return true;
      if (pending + valid.length > maxPending) { dropped += valid.length; return false; }
      pending += valid.length;
      valid.forEach(event => queued.add(event.eventId));
      const task = tail.then(async () => {
        await init();
        const fresh = valid.filter(event => !seen.has(event.eventId));
        // Retries (including after a restart) retain eventId. Readers deduplicate
        // by that durable ID as well; no duplicate retry changes counts.
        const unique = [...new Map(fresh.map(event => [event.eventId, event])).values()];
        if (unique.length) {
          const file = join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`);
          await appendFile(file, unique.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
          await chmod(file, 0o600);
          unique.forEach(event => remember(event.eventId));
        }
        return true;
      }).catch(() => {
        failures++; if (!warned) { warned = true; console.warn('[usage-events] Collection unavailable; work continues.'); }
        return false;
      }).finally(() => { pending -= valid.length; valid.forEach(event => queued.delete(event.eventId)); });
      tail = task.then(() => {});
      return task;
    });
    admissions.add(admission);
    void admission.then(() => admissions.delete(admission), () => admissions.delete(admission));
    return admission;
  }
  async function idle() {
    // Include calls still awaiting the persisted start time, before they join
    // the write queue. CLI exit and reads must observe those calls too.
    await Promise.all([...admissions]);
    await tail;
  }
  async function query({ days = 7, sessionId = '', limit = 100, maxScanned = 200_000 } = {}) {
    await idle();
    days = Math.max(1, Math.min(30, Math.floor(Number(days) || 7)));
    limit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const now = Date.now(), start = now - days * 86_400_000;
    let metadata = null, files = [], incomplete = false, scanned = 0;
    try { metadata = JSON.parse(await readFile(join(directory, 'collection.json'), 'utf8')); } catch {}
    try { files = (await readdir(directory)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)
      && name.slice(0, 10) >= new Date(start).toISOString().slice(0, 10)).sort().reverse(); } catch (error) { if (error.code !== 'ENOENT') incomplete = true; }
    const events = [], ids = new Set();
    for (const file of files) {
      const stream = createReadStream(join(directory, file), { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (++scanned > maxScanned) { incomplete = true; break; }
          if (line.length > 4096) { incomplete = true; continue; }
          let event; try { event = JSON.parse(line); } catch { incomplete = true; continue; }
          if (event.schemaVersion !== 1 || !event.eventId || ids.has(event.eventId)) continue;
          ids.add(event.eventId);
          if (event.timestamp < Math.max(start, Date.parse(metadata?.startedAt) || start)
              || event.timestamp > now + 60_000 || (sessionId && event.sessionId !== sessionId)) continue;
          events.push(event);
        }
      } catch { incomplete = true; }
      finally { lines.close(); stream.destroy(); }
      if (scanned > maxScanned) break;
    }
    events.sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
    const byEvent = {}, bySurface = {}, artifacts = {};
    for (const event of events) {
      byEvent[event.event] = (byEvent[event.event] || 0) + 1;
      bySurface[event.surface] = (bySurface[event.surface] || 0) + 1;
      if (['artifact_generated', 'artifact_attached', 'web_published'].includes(event.event)) {
        const key = `${event.event}:${event.kind || 'file'}:${event.operation || 'observed'}`;
        artifacts[key] = (artifacts[key] || 0) + 1;
      }
    }
    return { generatedAt: new Date(now).toISOString(), collectionStartedAt: metadata?.startedAt || null,
      window: { start: new Date(start).toISOString(), end: new Date(now).toISOString(), days },
      total: events.length, byEvent, bySurface, artifacts, paths: summarizeSurfacePaths(events),
      events: events.slice(-limit).reverse(), coverage: { incomplete, scanned, pending, dropped, failures,
        notes: ['仅包含采集启动后的可观测事件；不回填历史。', '飞书送达不代表已读；Web 呈现不代表理解或采纳。',
          '产物生成、网页发布、附加到回复与访问分别计数；普通文件写入不自动认定为产物。',
          '原生提问的等待有确定状态；自然语言中的隐含等待尚未自动识别。'] } };
  }
  return { record, query, idle };
}

export function summarizeSurfacePaths(events) {
  const groups = new Map();
  for (const event of events) {
    if (!event.personHash || !event.sessionId || event.actorKind !== 'human') continue;
    const key = `${event.personHash}:${event.sessionId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  let feishuStarted = 0, webOpened = 0, webContinued = 0, originalFeishuContinued = 0;
  for (const group of groups.values()) {
    const first = group.find(event => event.event === 'message_submitted');
    if (first?.surface !== 'feishu') continue;
    feishuStarted++;
    const opened = group.find(event => event.event === 'session_open' && event.timestamp >= first.timestamp && event.surface === 'web');
    const continued = group.find(event => event.event === 'message_submitted' && event.timestamp > first.timestamp && event.surface === 'web');
    if (opened) webOpened++;
    if (continued) webContinued++;
    const web = continued || opened;
    if (web && first.conversationKey && group.some(event => event.event === 'message_submitted'
      && event.surface === 'feishu' && event.timestamp > web.timestamp && event.conversationKey === first.conversationKey)) originalFeishuContinued++;
  }
  return { feishuStarted, webOpened, webContinued, originalFeishuContinued,
    scope: '窗口内首条观测输入在飞书的同一人、同一 Session；不是完整历史首发，也不代表任务完成。' };
}

export const usageEvents = createUsageEventStore();
export function observeUsage(input, context) { void usageEvents.record({ eventId: randomUUID(), ...input }, context); }
