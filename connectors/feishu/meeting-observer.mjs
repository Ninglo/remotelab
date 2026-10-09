import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createKeyedTaskQueue, writeJsonAtomic } from '../../chat/fs-utils.mjs';

const START = 'vc.meeting.all_meeting_started_v1';
const END = 'vc.meeting.all_meeting_ended_v1';
const str = value => typeof value === 'string' ? value.trim() : '';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Uses the Connector's existing authenticated transport; never opens a second
// same-app WebSocket (which would compete for ordinary chat events).
export function createFeishuMeetingObserver(runtime, options = {}) {
  const root = join(runtime.config.storageDir, 'meeting-observer');
  const policyPath = join(runtime.config.storageDir, 'meeting-observer-policy.json');
  const queue = createKeyedTaskQueue();
  const workers = new Map();
  const timers = new Map();
  const now = options.now || Date.now;
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel || clearTimeout;
  const request = options.request || (args => runtime.appClient.request(args));
  let stopped = false;

  async function policy() {
    try {
      const value = JSON.parse(await readFile(policyPath, 'utf8'));
      if (value.enabled !== true || value.appId !== runtime.config.appId || !str(value.tenantKey)) return null;
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  const statePath = id => join(root, `${id}.json`);
  async function readState(id) {
    try { return JSON.parse(await readFile(statePath(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function save(state) {
    state.updatedAt = new Date(now()).toISOString();
    await writeJsonAtomic(statePath(state.meetingId), state, { mode: 0o600 });
  }
  function targetFor(p, state) {
    const start = /^\d+$/.test(state.startedAt || '')
      ? Number(state.startedAt) * 1000 : Date.parse(state.startedAt);
    return (p.targets || []).find(t => /^\d{9}$/.test(t.meetingNo)
      && t.meetingNo === state.meetingNo
      && (t.ownerOpenIds || []).includes(state.ownerOpenId)
      && (!t.calendarEventId || t.calendarEventId === state.calendarEventId)
      && Number.isFinite(start) && Date.parse(t.notBefore) <= start
      && Date.parse(t.notBefore) <= now() && now() < Date.parse(t.expiresAt));
  }
  async function api(args) {
    const response = await request(args);
    if (response?.code !== 0) {
      const error = new Error(`Feishu API ${response?.code ?? 'invalid response'}: ${response?.msg || ''}`);
      error.code = response?.code;
      error.logId = response?.error?.log_id || response?.log_id;
      throw error;
    }
    return response.data || {};
  }
  function launch(id) {
    if (stopped || workers.has(id) || timers.has(id)) return;
    const worker = tick(id).catch(error => {
      console.warn(`[feishu-meeting] ${id}: ${error.message}`);
    }).finally(() => { if (workers.get(id) === worker) workers.delete(id); });
    workers.set(id, worker);
  }
  function next(id, ms) {
    if (stopped) return;
    const timer = schedule(() => { timers.delete(id); launch(id); }, ms);
    timer?.unref?.();
    timers.set(id, timer);
  }
  async function tick(id) {
    let again = false;
    let wait = 2000;
    await queue(id, async () => {
      const p = await policy();
      const state = await readState(id);
      if (!state || !p || state.appId !== p.appId || state.tenantKey !== p.tenantKey) return;
      const target = targetFor(p, state);
      if (!target || stopped) {
        if (state.joinAttempted && !state.captureStatus) {
          state.captureStatus = 'stopped_before_verified_end'; await save(state);
        }
        return;
      }
      if (state.captureStatus) return;
      try {
        if (!state.joinAttempted && !state.endedAt) {
          // Persist before the visible write. After a crash or ambiguous response
          // recovery only tries a read, never repeats the join.
          state.joinAttempted = true;
          state.joinRequestedAt = new Date(now()).toISOString();
          await save(state);
          const data = await api({ method: 'POST', url: '/open-apis/vc/v1/bots/join',
            data: { join_identify: { meeting_no: state.meetingNo }, join_type: 1 } });
          state.joinReceipt = data;
          if (str(data.meeting?.id) && data.meeting.id !== id) {
            state.captureStatus = 'join_meeting_id_mismatch';
            await save(state); return;
          }
          await save(state);
        }
        if (!state.joinAttempted) return;
        const data = await api({ method: 'GET', url: '/open-apis/vc/v1/bots/events',
          params: { meeting_id: id, page_size: 100, ...(state.pageToken ? { page_token: state.pageToken } : {}) } });
        state.eventsReadAt = new Date(now()).toISOString();
        state.joinVerifiedAt ||= state.eventsReadAt;
        const ids = new Set(state.events.map(e => e.event_id || digest(e)));
        for (const event of data.events || []) {
          const key = event.event_id || digest(event);
          if (ids.has(key)) continue;
          state.events.push(event); ids.add(key);
          if (event.event_type === 'transcript_received') {
            for (const item of event.payload?.transcript_received_items || []) {
              state.transcript.push({ ...item, sourceEventId: key });
            }
          }
          const meeting = event.payload?.meeting;
          if (meeting?.end_time && meeting.end_time !== '0') state.endedAt ||= String(meeting.end_time);
          if (event.event_type === 'meeting_ended') state.endedAt ||= str(event.event_time) || state.eventsReadAt;
        }
        state.pageToken = str(data.page_token) || state.pageToken;
        if (state.events.length > 20000) state.captureStatus = 'event_limit_reached';
        else if (state.endedAt && !data.has_more) state.captureStatus = 'ended_with_saved_events';
        state.readErrors = 0;
        await save(state);
        again = !state.captureStatus;
        wait = data.has_more ? 0 : 2000;
      } catch (error) {
        state.lastError = { message: error.message, code: error.code ?? null,
          ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
          ...(error.logId ? { logId: error.logId } : {}), at: new Date(now()).toISOString() };
        state.readErrors = (state.readErrors || 0) + 1;
        // Post-end denial cannot erase already captured text. A failed join is
        // recorded as a failure, not silently retried or reported as attendance.
        if (state.endedAt) state.captureStatus = 'ended_last_read_failed';
        else if (!state.joinReceipt && !state.joinVerifiedAt && error.code != null) state.captureStatus = 'join_or_access_denied';
        else if (state.readErrors >= 5) state.captureStatus = 'read_failed';
        await save(state);
        again = !state.captureStatus;
      }
    });
    if (again) next(id, wait);
  }
  async function handle(type, raw) {
    const p = await policy();
    if (!p || stopped) return {};
    const header = raw?.header || raw;
    const event = raw?.event || raw;
    if (str(header?.tenant_key) !== p.tenantKey
      || (str(header?.app_id) && header.app_id !== p.appId)) return {};
    const meeting = event?.meeting;
    const id = str(meeting?.id);
    if (!/^\d{10,30}$/.test(id)) return {};
    await queue(id, async () => {
      const old = await readState(id);
      const state = old || { appId: p.appId, tenantKey: p.tenantKey, meetingId: id,
        events: [], transcript: [], discoveryEvents: [] };
      state.meetingNo = str(meeting.meeting_no) || state.meetingNo;
      state.ownerOpenId = str(meeting.owner?.id?.open_id) || state.ownerOpenId;
      state.topic = str(meeting.topic) || state.topic;
      state.calendarEventId = str(meeting.calendar_event_id) || state.calendarEventId;
      const key = str(header.event_id) || digest({ type, meeting });
      if (!state.discoveryEvents.some(e => e.key === key)) {
        state.discoveryEvents.push({ key, type, receivedAt: new Date(now()).toISOString(), meeting });
      }
      if (type === START) state.startedAt ||= str(meeting.start_time) || new Date(now()).toISOString();
      if (type === END) state.endedAt ||= str(meeting.end_time) || new Date(now()).toISOString();
      await save(state);
    });
    launch(id);
    return {};
  }
  async function restore() {
    const p = await policy();
    if (!p) return false;
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const file of await readdir(root)) {
      if (/^\d{10,30}\.json$/.test(file)) launch(file.slice(0, -5));
    }
    console.log('[feishu-meeting] enterprise discovery enabled; automatic attendance requires an explicit target');
    return true;
  }
  function stop() { stopped = true; for (const timer of timers.values()) cancel(timer); timers.clear(); }
  async function idle() { await Promise.all([...workers.values()]); }
  return { handle, restore, stop, idle, handlers: {
    [START]: raw => handle(START, raw), [END]: raw => handle(END, raw),
  } };
}
