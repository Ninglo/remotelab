import { appendFile, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { buildUsageInsights } from './usage-insights.mjs';
import { readUsageSessionOrigins } from './usage-session-origins.mjs';
import { writeJsonAtomic } from './fs-utils.mjs';
import { summarizeFeishuCardEngagement, readFeishuCardSamplingCoverage } from '../lib/feishu-card-engagement.mjs';
import { validSettingObservation, validUsageSetting } from '../lib/usage-setting-schema.mjs';
import { readSettingSnapshot } from '../lib/usage-setting-store.mjs';

export const CLIENT_USAGE_EVENTS = new Set(['page_enter', 'session_open', 'page_visibility', 'ui_action', 'content_presented', 'artifact_open']);
const SERVER_EVENTS = new Set(['message_submitted', 'request_state', 'run_state', 'question_state', 'tool_started', 'tool_finished',
  'artifact_generated', 'artifact_registered', 'artifact_attached', 'web_published', 'delivery_state', 'artifact_access_requested', 'session_created', 'session_linked',
  'capability_state', 'automation_change', 'intervention', 'material_submitted', 'knowledge_state', 'feishu_card_action', 'feishu_card_read', 'setting_state']);
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
export function normalizeUsageEvent(input, { personId = '', verifiedPersonHash = '', client = false, now = Date.now() } = {}) {
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
  else if (!client && /^[a-f0-9]{64}$/.test(verifiedPersonHash)) event.personHash = verifiedPersonHash;
  if (input.event === 'setting_state') {
    if (!validSettingObservation({ setting: input.setting, value: input.settingValue, scope: input.settingScope,
      scopeKey: input.scopeKey, stage: input.stage, authority: input.authority })) return null;
    for (const key of ['setting', 'settingValue', 'settingScope', 'scopeKey', 'stage', 'authority']) event[key] = input[key];
    if (validUsageSetting(input.setting, input.previousValue)) event.previousValue = input.previousValue;
    if (/^[a-f0-9]{64}$/.test(input.subjectHash || '')) event.subjectHash = input.subjectHash;
  }
  if (!client && /^[a-f0-9]{64}$/.test(input.actorKey || '')) event.actorKey = input.actorKey;
  if (!client && identifier(input.sourceRouteId)) event.sourceRouteId = input.sourceRouteId;
  if (!client && ['expanded', 'collapsed', 'messages', 'card', 'default'].includes(input.mode)) event.mode = input.mode;
  if (!client && Number.isFinite(input.readAt) && input.readAt >= 0 && input.readAt <= now + 60_000) event.readAt = input.readAt;
  for (const key of ['sessionId', 'requestId', 'runId', 'visitId', 'parentSessionId', 'objectId', 'originObjectId', 'automationId', 'questionId', 'toolCallId', 'operationId', 'attemptId']) {
    const value = identifier(input[key]); if (value) event[key] = value;
  }
  for (const key of ['page', 'action', 'feature', 'state', 'kind', 'tool', 'origin', 'entry', 'conversationKey', 'operation']) {
    const value = token(input[key]);
    if (value && (!client || CLIENT_TOKENS[key]?.has(value))) event[key] = value;
  }
  for (const key of ['historySeq', 'sizeBytes', 'durationMs', 'deadline', 'attempts']) {
    const value = input[key]; if (Number.isFinite(value) && value >= 0) event[key] = value;
  }
  return event;
}

export function createUsageEventStore({ directory = join(CONFIG_DIR, 'usage-events'), maxPending = 2048,
  loadSessionOrigins = sessionIds => readUsageSessionOrigins(sessionIds, { requestsDirectory: join(CONFIG_DIR, 'requests'), hash: usageKey }) } = {}) {
  const activatedAt = Date.now();
  const collectionSince = readFile(join(directory, 'collection.json'), 'utf8')
    .then(raw => Date.parse(JSON.parse(raw).startedAt) || activatedAt)
    .catch(() => activatedAt);
  let tail = Promise.resolve(), pending = 0, dropped = 0, failures = 0, ready = false, warned = false;
  let firstIssueAt = 0, lastIssueAt = 0, persistedIssues = 0;
  const healthPath = join(directory, `health-${randomUUID()}.json`);
  const noteIssue = () => { lastIssueAt = Date.now(); firstIssueAt ||= lastIssueAt; };
  const seen = new Map(), queued = new Set(), admissions = new Set();
  const remember = id => { seen.set(id, true); if (seen.size > 50_000) seen.delete(seen.keys().next().value); };
  async function init() {
    if (ready) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try { await writeFile(join(directory, 'collection.json'), JSON.stringify({ schemaVersion: 1, startedAt: new Date(activatedAt).toISOString() }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    try { await writeFile(join(directory, 'features.json'), JSON.stringify({ startedAt: new Date(activatedAt).toISOString() }), { flag: 'wx', mode: 0o600 }); }
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
      if (pending + valid.length > maxPending) { dropped += valid.length; noteIssue(); return false; }
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
        if (failures + dropped > persistedIssues) {
          // Disk-full errors may prevent persisting their own receipt. Persist
          // the interrupted interval at the next successful append, so restart
          // cannot silently turn a known loss into a complete observation.
          try {
            await writeJsonAtomic(healthPath, { schemaVersion: 1, start: firstIssueAt, end: Date.now(), failures, dropped }, { mode: 0o600 });
            persistedIssues = failures + dropped;
          } catch { /* Keep process counters degraded until persistence recovers. */ }
        }
        return true;
      }).catch(() => {
        failures++; noteIssue(); if (!warned) { warned = true; console.warn('[usage-events] Collection unavailable; work continues.'); }
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
  async function query({ days = 7, sessionId = '', limit = 100, maxScanned = 200_000, settingSnapshot } = {}) {
    await idle();
    days = Math.max(1, Math.min(30, Math.floor(Number(days) || 7)));
    limit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const now = Date.now(), start = now - days * 86_400_000;
    let metadata = null, files = [], incomplete = false, scanned = 0;
    try { metadata = JSON.parse(await readFile(join(directory, 'collection.json'), 'utf8')); } catch {}
    const persistedGaps = [...(Array.isArray(metadata?.gaps) ? metadata.gaps : [])];
    try {
      const names = await readdir(directory);
      for (const name of names.filter(name => /^health-[a-f0-9-]+\.json$/.test(name))) {
        try { const incident = JSON.parse(await readFile(join(directory, name), 'utf8'));
          if (incident.schemaVersion === 1) persistedGaps.push(incident);
        } catch { incomplete = true; }
      }
    } catch (error) { if (error.code !== 'ENOENT') incomplete = true; }
    const gaps = persistedGaps.filter(gap =>
      Number.isFinite(gap.start) && Number.isFinite(gap.end) && gap.end >= start && gap.start <= now)
      .map(gap => ({ start: gap.start, end: gap.end }));
    const qualifiedStart = Math.max(start, Date.parse(metadata?.startedAt) || start, 0,
      ...gaps.map(gap => gap.end).filter(end => end <= now));
    const knownCorruptions = (Array.isArray(metadata?.knownCorruptions) ? metadata.knownCorruptions : []).filter(entry =>
      /^[a-f0-9]{64}$/.test(entry.sha256 || '') && Number.isFinite(entry.start) && Number.isFinite(entry.end)
      && entry.end <= qualifiedStart && persistedGaps.some(gap => gap.start <= entry.start && gap.end >= entry.end));
    const excludedFixtures = new Set((Array.isArray(metadata?.excludedFixtures) ? metadata.excludedFixtures : [])
      .filter(entry => entry.reason === 'confirmed_test_fixture' && /^[a-f0-9]{64}$/.test(entry.sha256 || '')).map(entry => entry.sha256));
    let excludedCorruptLines = 0, excludedFixtureLines = 0;
    try { files = (await readdir(directory)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)
      && name.slice(0, 10) >= new Date(start).toISOString().slice(0, 10)).sort().reverse(); } catch (error) { if (error.code !== 'ENOENT') incomplete = true; }
    let events = [];
    const ids = new Set();
    for (const file of files) {
      const stream = createReadStream(join(directory, file), { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (++scanned > maxScanned) { incomplete = true; break; }
          if (excludedFixtures.size && excludedFixtures.has(createHash('sha256').update(line).digest('hex'))) {
            excludedFixtureLines++; continue;
          }
          if (line.length > 4096) { incomplete = true; continue; }
          let event; try { event = JSON.parse(line); } catch {
            if (knownCorruptions.some(entry => entry.sha256 === createHash('sha256').update(line).digest('hex'))) excludedCorruptLines++;
            else incomplete = true;
            continue;
          }
          if (event.schemaVersion !== 1 || !event.eventId || ids.has(event.eventId)) continue;
          ids.add(event.eventId);
          if (event.timestamp < Math.max(start, Date.parse(metadata?.startedAt) || start)
              || event.timestamp > now + 60_000) continue;
          events.push(event);
        }
      } catch { incomplete = true; }
      finally { lines.close(); stream.destroy(); }
      if (scanned > maxScanned) break;
    }
    const settingEvents = events.filter(event => event.event === 'setting_state');
    settingSnapshot ||= await readSettingSnapshot(join(directory, '..', 'usage-settings'));
    if (sessionId) {
      const children = events.filter(event => event.event === 'session_linked' && event.parentSessionId === sessionId);
      const childIds = new Set(children.map(event => event.sessionId)), runIds = new Set(children.map(event => event.runId).filter(Boolean));
      events = events.filter(event => event.sessionId === sessionId
        || (event.event === 'session_linked' && event.parentSessionId === sessionId)
        || (event.event === 'run_state' && runIds.has(event.runId))
        || (event.event === 'session_open' && event.actorKind === 'human' && childIds.has(event.sessionId)));
    }
    events.sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
    const scanIncomplete = incomplete;
    const originFacts = await loadSessionOrigins(events.filter(event => event.actorKind === 'human' && ['message_submitted', 'session_open'].includes(event.event)
      && event.timestamp >= qualifiedStart && event.timestamp <= now).map(event => event.sessionId));
    let featureStartedAt = null;
    try { featureStartedAt = JSON.parse(await readFile(join(directory, 'features.json'), 'utf8')).startedAt; } catch {}
    if (gaps.length) incomplete = true;
    const byEvent = {}, bySurface = {}, artifacts = {};
    for (const event of events) {
      byEvent[event.event] = (byEvent[event.event] || 0) + 1;
      bySurface[event.surface] = (bySurface[event.surface] || 0) + 1;
      if (['artifact_generated', 'artifact_attached', 'web_published'].includes(event.event)) {
        const key = `${event.event}:${event.kind || 'file'}:${event.operation || 'observed'}`;
        artifacts[key] = (artifacts[key] || 0) + 1;
      }
    }
    const feishuCardSampling = await readFeishuCardSamplingCoverage(join(directory, '..', 'feishu-card-reads'));
    return { generatedAt: new Date(now).toISOString(), collectionStartedAt: metadata?.startedAt || null,
      window: { start: new Date(start).toISOString(), end: new Date(now).toISOString(), days },
      total: events.length, byEvent, bySurface, artifacts, paths: summarizeSurfacePaths(events),
      feishuCards: { ...summarizeFeishuCardEngagement(events), sampling: feishuCardSampling },
      report: buildUsageInsights(events, { start, now, collectionStartedAt: metadata?.startedAt, gaps, scanIncomplete,
        dropped: lastIssueAt >= qualifiedStart ? dropped : 0, failures: lastIssueAt >= qualifiedStart ? failures : 0,
        sessionOrigins: originFacts.origins, originLookupIncomplete: originFacts.truncated || originFacts.errors > 0, featureStartedAt, feishuCardSampling,
        settingEvents, settingSnapshot }),
      events: events.slice(-limit).reverse(), coverage: { incomplete, scanIncomplete, scanned, pending, dropped, failures, gaps, excludedCorruptLines, excludedFixtureLines,
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
