#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuUserReminders } from '../display/feishu-user-reminders.mjs';

const dir = await mkdtemp(join(tmpdir(), 'display-feishu-auth-'));
let clock = Date.parse('2026-09-25T08:00:00Z');
let authorizedOpenId = 'ou_wrong';
let codeNumber = 0;
let messageIds = ['one', 'two'];
let mentionIds = ['one'];
const created = new Map();
const readIds = new Set();
let readStatusFailure = false;
let numericTimestamps = false;
let rejectRefresh = false;
let emptyCalendar = false;
let refreshCount = 0;
const seen = [];
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const fakeFetch = async (url, options) => {
  const path = new URL(url).pathname;
  seen.push({ path, method: options.method, body: String(options.body || '') });
  if (path.endsWith('/device_authorization')) {
    const requested = new URLSearchParams(options.body).get('scope').split(' ');
    assert.deepEqual(requested, ['search:message', 'im:message:readonly', 'calendar:calendar:read',
      'calendar:calendar.event:read', 'offline_access'], 'one consent requests all display scopes enabled for the app');
    codeNumber++;
    return response({ device_code: `device-${codeNumber}`, user_code: `ABCD-${codeNumber}`,
      verification_uri: 'https://accounts.feishu.cn/oauth/authorize', expires_in: 240, interval: 5 });
  }
  if (path.endsWith('/oauth/token') && options.headers['Content-Type'] === 'application/json') {
    assert.equal(JSON.parse(options.body).grant_type, 'refresh_token', 'Feishu v2 refresh requires JSON');
    if (rejectRefresh) return response({ error: 'invalid_grant' }, 400);
    refreshCount++;
    return response({ access_token: `access-refresh-${refreshCount}`, refresh_token: `refresh-rotated-${refreshCount}`,
      expires_in: 7200, refresh_token_expires_in: 604800,
      scope: 'auth:user.id:read im:message:readonly search:message calendar:calendar:read calendar:calendar.event:read offline_access' });
  }
  if (path.endsWith('/oauth/token')) return response({ access_token: `access-${codeNumber}`,
    refresh_token: `refresh-${codeNumber}`, expires_in: 7200, refresh_token_expires_in: 604800,
    scope: codeNumber >= 4 ? 'auth:user.id:read im:message:readonly search:message calendar:calendar:read calendar:calendar.event:read offline_access'
      : codeNumber === 3 ? 'auth:user.id:read im:message:readonly search:message calendar:calendar.event:read offline_access'
      : 'auth:user.id:read im:message:readonly search:message offline_access' });
  if (path.endsWith('/user_info')) return response({ code: 0, data: { open_id: authorizedOpenId } });
  if (path.endsWith('/tenant_access_token/internal')) return response({ code: 0, tenant_access_token: 'tenant-test', expire: 7200 });
  if (path.endsWith('/messages/mget')) {
    const ids = new URL(url).searchParams.getAll('message_ids');
    return response({ code: 0, data: { items: ids.map((message_id) => ({ message_id,
      ...(message_id === 'om_topicroot' || message_id === 'om_topicmyroot' || message_id === 'om_topicotherroot'
        ? {} : { parent_id: message_id === 'om_topicdirect' ? 'om_topicmyroot' : 'om_topicotherroot' }),
      sender: { sender_type: 'user', id: message_id === 'om_topicmyroot' ? 'ou_expected' : 'ou_other_person' },
      ...(message_id === 'om_topicmention' ? { mentions: [{ id: 'ou_expected', id_type: 'open_id' }] }
        : message_id === 'om_topicall' ? { mentions: [{ id: 'all' }] } : {}),
    })) } });
  }
  if (path.endsWith('/calendar/v4/calendars/primary')) return response({ code: 0, data: { calendar_id: 'cal_main', type: 'primary' } });
  if (path.endsWith('/events/instance_view') && emptyCalendar) return response({ code: 0, data: {} });
  if (path.endsWith('/events/instance_view')) return response({ code: 0, data: { items: [
    { event_id: 'evt_soon', summary: '项目同步', start_time: { timestamp: String(Math.floor(clock / 1000) + 300) }, status: 'confirmed', self_rsvp_status: 'accept' },
    { event_id: 'evt_declined', summary: '已拒绝', start_time: { timestamp: String(Math.floor(clock / 1000) + 300) }, status: 'confirmed', self_rsvp_status: 'decline' },
  ] } });
  if (path.includes('/im/v1/chats/')) return response({ code: 0, data: path.includes('oc_main')
    ? { chat_mode: 'group', name: '产品讨论群' } : path.includes('oc_topic')
      ? { chat_mode: 'topic', name: 'AI 干活群' } : { chat_mode: 'p2p', name: '' } });
  if (path.endsWith('/messages/read_status')) {
    if (readStatusFailure) return response({ code: 99991679, msg: 'read status unavailable' });
    const body = JSON.parse(options.body);
    assert(body.message_ids.length > 0 && body.message_ids.length <= 50);
    return response({ code: 0, data: { items: body.message_ids.map((message_id) => ({ message_id,
      is_read: readIds.has(message_id) })), invalid_message_ids: [] } });
  }
  if (path.endsWith('/messages/search')) {
    const body = JSON.parse(options.body);
    assert.match(body.filter.time_range.start_time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
    assert.match(body.filter.time_range.end_time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
    return response({ code: 0, data: { items: (body.filter.is_at_me ? mentionIds : messageIds).map((id) => ({ id: `om_${id}`,
      meta_data: { message_id: `om_${id}`, from_id: ['mine', 'reply'].includes(id) ? 'ou_expected' : 'ou_other_person',
        chat_id: id === 'mine' ? 'oc_mine12345678' : id === 'four' ? 'oc_other12345678'
          : id.startsWith('topic') ? 'oc_topic12345678' : 'oc_main12345678',
        is_p2p_chat: id === 'four', create_time: numericTimestamps
          ? String(created.get(id) || clock) : new Date(created.get(id) || clock).toISOString(),
        ...(id.startsWith('topic') ? { thread_id: 'omt_thread', thread_position: 3 } : {}) } })), has_more: false } });
  }
  throw Error(`Unexpected API ${path}`);
};
try {
  const config = join(dir, 'feishu-connectors', 'bot-2');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'config.json'), JSON.stringify({ appId: 'test-app', appSecret: 'test-secret' }));
  const service = createFeishuUserReminders({ configDir: dir,
    identityFor: async (id) => id === 'person_a' ? { realm: 'bot-2', openId: 'ou_expected' } : null,
    fetchImpl: fakeFetch, now: () => clock });
  assert.equal((await service.begin('person_b')).linked, false);
  const started = await service.begin('person_a');
  assert.equal(started.pending, true);
  assert.equal(started.connected, false);
  assert(!JSON.stringify(started).includes('test-secret'));
  assert.equal((await service.status('person_a')).pending, true);
  clock += 5000;
  const wrongUser = await service.status('person_a');
  assert.equal(wrongUser.connected, false, 'another Feishu user cannot grant this Person');
  assert.match(wrongUser.error, /不一致/);
  authorizedOpenId = 'ou_expected';
  await service.begin('person_a');
  clock += 5000;
  const connected = await service.status('person_a');
  assert.equal(connected.connected, true);
  assert(!JSON.stringify(connected).includes('access-'));
  const summary = await service.summary('person_a');
  assert.deepEqual([summary.connected, summary.available, summary.recentMessages, summary.mentions24h], [true, true, 2, 1]);
  assert.deepEqual([summary.newMessages, summary.newMentions], [0, 0], 'old messages are a baseline, not new alerts');
  messageIds = ['three', ...messageIds];
  mentionIds = ['three', ...mentionIds];
  clock += 5001;
  const searchesBefore = seen.filter(({ path }) => path.endsWith('/messages/search')).length;
  assert.equal(service.latest('person_a').newMessages, 0, 'a stale summary returns without waiting for Feishu');
  const fresh = await service.summary('person_a');
  assert.equal(seen.filter(({ path }) => path.endsWith('/messages/search')).length - searchesBefore, 2,
    'background and foreground reads share one Feishu search round');
  assert.deepEqual([fresh.newMessages, fresh.newMentions], [1, 1]);
  assert.equal(fresh.readStateAvailable, true);
  assert.deepEqual(fresh.sources, [{ label: '群聊 · 产品讨论群', count: 1 }]);
  assert(!JSON.stringify(fresh).includes('ou_other_person'));
  messageIds = ['mine', 'old-unseen', ...messageIds];
  created.set('old-unseen', clock - 60_000);
  clock += 5001;
  assert.equal((await service.summary('person_a')).newMessages, 1, 'outgoing and old unseen search results do not create alerts');
  messageIds = ['four', ...messageIds];
  clock += 5001;
  const later = await service.summary('person_a');
  assert.equal(later.newMessages, 2);
  assert.deepEqual(later.sources, [{ label: '私聊对话', count: 1 }, { label: '群聊 · 产品讨论群', count: 1 }]);
  assert.equal((await service.acknowledge('person_a', fresh.observedAt)).cleared, 1);
  assert.equal((await service.summary('person_a')).newMessages, 1, 'a message arriving after the reviewed snapshot remains visible');
  assert.equal((await service.acknowledge('person_a', later.observedAt)).cleared, 1);
  assert.equal((await service.summary('person_a')).newMessages, 0);
  messageIds = ['five', ...messageIds];
  numericTimestamps = true;
  clock += 5001;
  created.set('five', clock);
  assert.equal((await service.summary('person_a')).newMessages, 1);
  messageIds = ['reply', ...messageIds];
  clock += 5001;
  created.set('reply', clock);
  assert.equal((await service.summary('person_a')).newMessages, 0, 'a reply in the same chat clears its alert');
  messageIds = ['six', ...messageIds];
  clock += 5001;
  assert.equal((await service.summary('person_a')).newMessages, 1, 'an older reply does not clear a later message');
  messageIds = messageIds.filter((id) => id !== 'reply');
  clock += 5001;
  assert.equal((await service.summary('person_a')).newMessages, 1);
  clock += 30_001;
  assert.equal((await service.summary('person_a')).newMessages, 1, 'an arrival remains visible until this display acknowledges it');
  const persistent = await service.summary('person_a');
  assert.equal(persistent.readStateAvailable, true);
  assert.equal((await service.acknowledge('person_a', persistent.observedAt)).cleared, 1);
  assert.equal((await service.summary('person_a')).newMessages, 0);
  messageIds = ['seven', ...messageIds];
  clock += 5001;
  assert.equal((await service.summary('person_a')).newMessages, 1);
  readIds.add('om_seven');
  clock += 5001;
  assert.equal((await service.summary('person_a')).newMessages, 0, 'reading in Feishu clears the prompt without a display acknowledgement');
  messageIds = ['eight', ...messageIds];
  readStatusFailure = true;
  clock += 5001;
  const unavailable = await service.summary('person_a');
  assert.deepEqual([unavailable.newMessages, unavailable.readStateAvailable], [1, false], 'an API failure keeps the arrival without claiming it is unread');
  readStatusFailure = false;
  readIds.add('om_eight');
  clock += 5001;
  assert.equal((await service.summary('person_a')).newMessages, 0);
  messageIds = ['topicreply', ...messageIds];
  clock += 5001;
  assert.equal((await service.summary('person_a')).newMessages, 0,
    'ordinary topic replies do not become false unread alerts');
  messageIds = ['topicmention', ...messageIds];
  mentionIds = ['topicmention', ...mentionIds];
  clock += 5001;
  const topicMention = await service.summary('person_a');
  assert.equal(topicMention.newMessages, 1, 'a topic reply that mentions this user remains actionable');
  assert.deepEqual(topicMention.sources, [{ label: '话题群 · AI 干活群', count: 1 }]);
  assert.equal((await service.acknowledge('person_a', topicMention.observedAt)).cleared, 1);
  messageIds = ['topicall', ...messageIds];
  mentionIds = ['topicall', ...mentionIds];
  clock += 5001;
  assert.equal((await service.summary('person_a')).newMessages, 0,
    'a broad mention search hit without an exact @me does not alert in a topic');
  messageIds = ['topicroot', ...messageIds];
  clock += 5001;
  assert.equal((await service.summary('person_a')).newMessages, 0,
    'a new topic without @me is not a directed notification');
  messageIds = ['topicdirect', ...messageIds];
  clock += 5001;
  const directReply = await service.summary('person_a');
  assert.equal(directReply.newMessages, 1, 'a reply whose parent message is mine remains actionable');
  assert.deepEqual(directReply.sources, [{ label: '话题群 · AI 干活群', count: 1 }]);
  assert.equal((await service.acknowledge('person_a', directReply.observedAt)).cleared, 1);
  messageIds = ['frontier-new', 'frontier-old', ...messageIds];
  created.set('frontier-old', clock + 5001);
  created.set('frontier-new', clock + 10_002);
  readIds.add('om_frontier-new');
  clock += 10_002;
  assert.equal((await service.summary('person_a')).newMessages, 0,
    'a newer read message in an ordinary chat resolves an older false read-status result');
  const notifications = JSON.parse(await readFile(join(dir, 'display-private', 'feishu-notifications.json'), 'utf8'));
  assert.equal(notifications.people.person_a.pending.length, 0);
  assert.equal((await stat(join(dir, 'display-private', 'feishu-notifications.json'))).mode & 0o777, 0o600);
  assert.equal((await service.summary('person_b')).connected, false);
  const saved = join(dir, 'display-private', 'feishu-reminders.json');
  assert.equal((await stat(saved)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(saved, 'utf8')).people.person_a.token.openId, 'ou_expected');
  assert.equal(seen.filter(({ path }) => path.endsWith('/messages/search')).length, 44);
  const upgrade = await service.begin('person_a');
  assert.equal(upgrade.connected, true, 'message access remains available during calendar authorization');
  assert.equal(upgrade.calendarConnected, false);
  assert.equal(upgrade.pending, true);
  clock += 5000;
  const partial = await service.status('person_a');
  assert.equal(partial.calendarConnected, false);
  assert.match(partial.error, /主日历读取权限/, 'partial grants must be visible to the user');
  assert.equal((await service.begin('person_a')).pending, true);
  clock += 5000;
  const calendarGrant = await service.status('person_a');
  assert.equal(calendarGrant.calendarConnected, true);
  messageIds = ['outage-old', ...messageIds];
  clock += 5001;
  created.set('outage-old', clock);
  assert.equal((await service.summary('person_a')).newMessages, 1);
  const calendar = await service.calendarSummary('person_a');
  assert.equal(calendar.available, true);
  assert.deepEqual(calendar.due.map((item) => item.title), ['项目同步']);
  emptyCalendar = true;
  clock += 60_001;
  const empty = await service.calendarSummary('person_a');
  assert.equal(empty.available, true, 'an empty successful Feishu calendar response is still connected');
  assert.deepEqual(empty.due, []);
  const beforeRefresh = JSON.parse(await readFile(join(dir, 'display-private', 'feishu-reminders.json'), 'utf8')).people.person_a.token;
  clock = beforeRefresh.expiresAt - 4 * 60_000;
  await service.maintain();
  const maintained = JSON.parse(await readFile(join(dir, 'display-private', 'feishu-reminders.json'), 'utf8')).people.person_a.token;
  assert.equal(refreshCount, 1, 'maintenance refreshes without an open preview');
  assert.equal(maintained.refreshToken, 'refresh-rotated-1', 'one-use refresh token is durably replaced');
  assert.equal((await service.status('person_a')).connected, true);
  rejectRefresh = true;
  clock += 7_200_001;
  const expired = await service.status('person_a');
  assert.equal(expired.connected, false, 'a revoked token must not be shown as connected');
  assert.match(expired.error, /重新连接/);
  assert.equal((await service.begin('person_a')).pending, true, 'a failed refresh must allow a new user grant');
  assert.equal((await service.status('person_a')).error, null, 'pending reauthorization should show the new consent action');
  messageIds = ['outage-during', ...messageIds];
  created.set('outage-during', clock - 60_000);
  rejectRefresh = false;
  clock += 5000;
  assert.equal((await service.status('person_a')).connected, true);
  const reconnected = await service.summary('person_a');
  assert.equal(reconnected.newMessages, 0, 'an old pending alert and disconnected backfill do not become new mail');
  const afterReconnect = JSON.parse(await readFile(join(dir, 'display-private', 'feishu-notifications.json'), 'utf8')).people.person_a;
  assert.equal(afterReconnect.reconciled.filter((item) => item.reason === 'reconnect_backfill').length, 2,
    'backfill stays in the private audit with Feishu read-status evidence');
  assert(afterReconnect.reconciled.every((item) => item.apiIsRead === false));
  messageIds = ['post-reconnect', ...messageIds];
  clock += 5001;
  created.set('post-reconnect', clock);
  assert.equal((await service.summary('person_a')).newMessages, 1, 'a new message after reconnect still alerts');
  const originalRefreshExpiry = maintained.refreshExpiresAt;
  clock = originalRefreshExpiry + 1000;
  await service.maintain();
  const longLived = JSON.parse(await readFile(saved, 'utf8')).people.person_a.token;
  assert(longLived.refreshExpiresAt > clock && longLived.grantedAt < clock,
    'rotated refresh tokens retain consent beyond the first seven-day token lifetime');
  console.log('ok - Feishu consent, person binding, real read status, chat sources, and acknowledgement');
} finally { await rm(dir, { recursive: true, force: true }); }
