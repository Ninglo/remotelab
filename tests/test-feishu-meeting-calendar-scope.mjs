import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMeetingScopeChecker } from '../connectors/feishu/meeting-scope.mjs';
import { writeDurableJson } from '../lib/durable-records.mjs';

const root = await mkdtemp(join(tmpdir(), 'meeting-calendar-scope-'));
const uid = '12345678-abcd';
const id = '1234567890123456789';
const start = '1794924404';
const end = '1794927974';
const instance = `${uid}_1794924000`;
const master = `${uid}_0`;
const discovery = { meetingId: id, appId: 'cli_test', tenantKey: 'tenant', endedAt: end };
const runtime = { config: { storageDir: root } };
const target = { chatId: 'oc_source', cardMessageId: 'om_card' };
const required = ['ou_a', 'ou_b', 'ou_c'];
const policy = { appId: discovery.appId, tenantKey: discovery.tenantKey, scope: {
  mode: 'source_group_or_organizer', organizerOpenIds: ['ou_a'],
  calendarSource: { notBefore: '2026-11-16T00:00:00Z', targets: { [uid]: target }, requiredParticipantOpenIds: required },
} };
const roster = [{ id: 'ou_a', first_join_time: start }, { id: { open_id: 'ou_b' }, in_meeting_duration: '60' },
  { id: 'ou_c', first_join_time: start }];
const group = { type: 'chat', chat_id: target.chatId, rsvp_status: 'needs_action' };
let meeting, requests, eventStatus, cardChat, listError, pages, inGroup, duplicates, wrongInstance;
function reset() {
  meeting = { id, calendar_event_id: instance, owner: { id: 'ou_other' }, participants: roster, start_time: start };
  requests = []; eventStatus = 'confirmed'; cardChat = target.chatId; listError = null; inGroup = true;
  pages = [{ has_more: true, page_token: 'next', items: [] }, { has_more: false, items: [group] }];
  duplicates = false; wrongInstance = false;
}
const api = async ({ method, url, params }) => {
  assert.equal(method, 'GET');
  requests.push(url);
  if (url.includes('/vc/')) return { meeting };
  if (url.endsWith('/is_in_chat')) return { is_in_chat: inGroup };
  if (url.endsWith('/messages/om_card')) return { items: [{ message_id: 'om_card', chat_id: cardChat,
    msg_type: 'share_calendar_event', body: { content: JSON.stringify({ open_event_id: instance, open_calendar_id: 'shared' }) } }] };
  if (url.endsWith(`/shared/events/${instance}`)) return { event: { event_id: instance, organizer_calendar_id: 'organizer' } };
  if (url.endsWith(`/organizer/events/${master}`)) return { event: { event_id: master, recurrence: 'FREQ=WEEKLY' } };
  if (url.endsWith(`/organizer/events/${instance}`)) return { event: { event_id: wrongInstance ? `${uid}_1` : instance, status: eventStatus } };
  if (url.endsWith('/organizer/events/instance_view')) {
    assert.deepEqual(params, { start_time: start, end_time: end });
    const item = { event_id: instance, status: 'confirmed', start_time: { timestamp: start }, end_time: { timestamp: end } };
    return { items: duplicates ? [item, { ...item, event_id: `${uid}_1` }] : [item] };
  }
  if (url.endsWith(`/organizer/events/${instance}/attendees`)) {
    if (listError) throw Object.assign(Error('provider rejection'), { code: listError, logId: 'diagnostic' });
    return pages[params.page_token ? 1 : 0];
  }
  assert.fail(`Unexpected request: ${url}`);
};
const check = createMeetingScopeChecker(runtime, api, { cli: async () => assert.fail('Never use personal OAuth for calendar') });
const checkReason = async (reason, p = policy, d = discovery) => assert.equal((await check(p, d)).reason, reason);
try {
  reset();
  const allowed = await check(policy, discovery);
  assert.equal(allowed.reason, 'calendar_invited_source_group');
  assert.equal(allowed.calendarInstanceId, instance);
  assert.equal(requests.filter(url => url.endsWith('/attendees')).length, 2);
  reset(); meeting.calendar_event_id = master;
  await checkReason('calendar_invited_source_group');
  assert(requests.some(url => url.endsWith('/instance_view')));
  reset(); meeting.calendar_event_id = master; duplicates = true;
  await checkReason('calendar_instance_unverified');
  reset(); meeting.calendar_event_id = master;
  await writeDurableJson(join(root, 'meeting-observer', id + '.json'), { ...discovery, calendarEventId: instance });
  await checkReason('calendar_invited_source_group');
  assert(!requests.some(url => url.endsWith('/instance_view')));
  reset(); meeting.calendar_event_id = `${uid}_1794924001`;
  await checkReason('calendar_instance_unverified');
  reset(); meeting.participants = roster.slice(0, 2).concat({ id: 'ou_c', status: 4 });
  await checkReason('calendar_required_attendees_unverified');
  assert.equal(requests.length, 1);
  reset(); cardChat = 'oc_other';
  await checkReason('calendar_source_card_unverified');
  reset(); eventStatus = 'cancelled';
  await checkReason('calendar_instance_unverified');
  reset(); wrongInstance = true;
  await checkReason('calendar_instance_unverified');
  reset(); inGroup = false;
  await checkReason('calendar_bot_not_in_source_group');
  reset(); listError = 194001;
  const denied = await check(policy, discovery);
  assert.equal(denied.reason, 'calendar_invite_lookup_denied');
  assert.equal(denied.error.code, 194001);
  const p = structuredClone(policy);
  p.scope.calendarSource.targets[uid] = { chatId: target.chatId,
    confirmedBinding: { organizerCalendarId: 'organizer', sourceRef: 'feishu:om_decision' } };
  await checkReason('calendar_confirmed_source_binding', p);
  reset(); listError = 193001;
  await checkReason('calendar_source_lookup_failed', p);
  reset(); pages = [{ has_more: false, items: [{ ...group, is_removed: true }, { ...group, chat_id: 'oc_other' }] }];
  await checkReason('calendar_source_group_not_invited', p);
  reset(); pages[1] = pages[0];
  await checkReason('calendar_invite_list_incomplete');
  reset(); await checkReason('outside_source_group_and_organizers', policy, { ...discovery, endedAt: '1794100000' });
  assert.equal(requests.length, 1, 'no calendar queries before the new cutoff');
  reset(); await checkReason('meeting_identity_unverified', policy, { ...discovery, tenantKey: 'other' });
  assert.equal(requests.length, 0);
  reset(); meeting.chat_id = 'oc_native';
  await checkReason('source_group_member');
  assert.equal(requests.length, 2);
  reset(); meeting.owner = { id: 'ou_a' };
  await checkReason('authorized_organizer');
  assert.equal(requests.length, 1);
  console.log('meeting calendar scope: native card, organizer, exact instance, pagination, real attendance, ACL fallback, source membership, cutoff and legacy scope passed');
} finally { await rm(root, { recursive: true, force: true }); }
