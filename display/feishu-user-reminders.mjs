import { readFile, chmod, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readJson } from '../chat/fs-utils.mjs';

// The bot-2 application has calendar:calendar:read enabled. Requesting
// calendar:calendar:readonly silently produced a partial user grant instead.
const CALENDAR_SCOPES = ['calendar:calendar:read', 'calendar:calendar.event:read'];
const MESSAGE_SCOPES = ['search:message', 'im:message:readonly'];
const SCOPES = [...MESSAGE_SCOPES, ...CALENDAR_SCOPES, 'offline_access'].join(' ');
const grantedScopes = (scope) => new Set(clean(scope).split(/\s+/));
const hasMessageScope = (scope) => MESSAGE_SCOPES.every((name) => grantedScopes(scope).has(name));
const hasCalendarScope = (scope) => {
  const granted = grantedScopes(scope);
  return granted.has('calendar:calendar.event:read') &&
    (granted.has('calendar:calendar:read') || granted.has('calendar:calendar:readonly') || granted.has('calendar:calendar'));
};
const hasRequiredScope = (scope) => hasMessageScope(scope) && hasCalendarScope(scope) && grantedScopes(scope).has('offline_access');
function missingGrant(scope) {
  const granted = grantedScopes(scope);
  return [
    !hasMessageScope(scope) && '消息读取',
    !(granted.has('calendar:calendar:read') || granted.has('calendar:calendar:readonly') || granted.has('calendar:calendar')) && '主日历读取',
    !granted.has('calendar:calendar.event:read') && '日程读取',
    !granted.has('offline_access') && '持续同步',
  ].filter(Boolean);
}
const ACCOUNTS = 'https://accounts.feishu.cn';
const OPEN = 'https://open.feishu.cn';
const feishuTime = (value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, '+00:00');
function messageTime(value) {
  if (typeof value === 'number' || /^\d+$/.test(value || '')) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric * (numeric < 100_000_000_000 ? 1000 : 1) : NaN;
  }
  return Date.parse(value || '');
}

function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function seconds(value, fallback) { return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
function safeRealm(value) { return /^[a-z0-9_-]+$/.test(value || '') ? value : ''; }

export function createFeishuUserReminders({ configDir, identityFor, fetchImpl = fetch, now = Date.now }) {
  const privateDir = join(configDir, 'display-private');
  const file = join(privateDir, 'feishu-reminders.json');
  const notificationFile = join(privateDir, 'feishu-notifications.json');
  let lock = Promise.resolve();
  const cached = new Map();
  const refreshing = new Map();
  const calendarCached = new Map();
  const calendarRefreshing = new Map();
  const tenantTokens = new Map();
  const chatSources = new Map();
  const refreshFailures = new Map();
  const queued = (task) => {
    const running = lock.then(task);
    lock = running.catch(() => {});
    return running;
  };
  const document = () => readJson(file, { version: 1, people: {} });
  async function save(value) {
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    await chmod(privateDir, 0o700);
    const temporary = `${file}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  const messageKey = (value) => createHash('sha256').update(String(value)).digest('hex');
  async function saveNotifications(value) {
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    const temporary = `${notificationFile}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, notificationFile);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  async function appFor(realm) {
    const name = safeRealm(realm);
    if (!name) throw new Error('飞书身份来源无效');
    const source = name === 'primary'
      ? join(configDir, 'feishu-connector', 'config.json')
      : join(configDir, 'feishu-connectors', name, 'config.json');
    const config = JSON.parse(await readFile(source, 'utf8'));
    if (!clean(config.appId) || !clean(config.appSecret)) throw new Error('飞书应用配置缺失');
    return { appId: config.appId, appSecret: config.appSecret };
  }
  async function request(url, { form, data, token, basic } = {}) {
    const headers = {};
    let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form); }
    if (data) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data); }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (basic) headers.Authorization = `Basic ${Buffer.from(`${basic.appId}:${basic.appSecret}`).toString('base64')}`;
    const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', headers, body,
      signal: AbortSignal.timeout(10_000) });
    const json = await response.json().catch(() => ({}));
    return { ok: response.ok && (json.code === undefined || json.code === 0) && !json.error, json, status: response.status };
  }
  function publicStatus(entry, linked = true) {
    const pending = entry?.pending;
    const tokenValid = Boolean(entry?.token?.accessToken && entry.token.expiresAt > now());
    return {
      linked,
      connected: tokenValid && hasMessageScope(entry.token.scope),
      calendarConnected: tokenValid && hasCalendarScope(entry.token.scope),
      pending: Boolean(pending && pending.expiresAt > now()),
      verificationUrl: pending?.expiresAt > now() ? pending.verificationUrl : null,
      userCode: pending?.expiresAt > now() ? pending.userCode : null,
      expiresAt: pending?.expiresAt > now() ? new Date(pending.expiresAt).toISOString() : null,
      error: clean(entry?.error) || null,
    };
  }
  async function expected(personId) {
    const identity = await identityFor(personId);
    if (!identity?.openId || !safeRealm(identity.realm)) return null;
    return identity;
  }
  async function begin(personId) {
    const identity = await expected(personId);
    if (!identity) return { linked: false, connected: false, pending: false, error: '当前账号尚未绑定飞书身份' };
    await accessToken(personId, identity);
    return queued(async () => {
      const doc = await document();
      const entry = doc.people?.[personId] || {};
      if (entry.token && (entry.token.openId !== identity.openId || entry.token.realm !== identity.realm)) delete entry.token;
      if (entry.token?.accessToken && entry.token.expiresAt > now() && hasRequiredScope(entry.token.scope)
        && entry.token.openId === identity.openId && entry.token.realm === identity.realm) return publicStatus(entry);
      if (entry.pending?.expiresAt > now() && entry.pending.realm === identity.realm) return publicStatus(entry);
      const app = await appFor(identity.realm);
      const response = await request(`${ACCOUNTS}/oauth/v1/device_authorization`, {
        form: { client_id: app.appId, scope: SCOPES }, basic: app,
      });
      const data = response.json;
      const verificationUrl = clean(data.verification_uri_complete || data.verification_uri);
      if (!response.ok || !clean(data.device_code) || !/^https:\/\/(?:accounts\.feishu\.cn|open\.feishu\.cn)\//.test(verificationUrl)) {
        throw new Error(`飞书授权入口暂不可用${clean(data.error) ? `：${clean(data.error)}` : ''}`);
      }
      const intervalMs = Math.max(5, seconds(data.interval, 5)) * 1000;
      const next = { ...entry, error: '', pending: {
        realm: identity.realm, expectedOpenId: identity.openId, deviceCode: data.device_code,
        verificationUrl, userCode: clean(data.user_code), expiresAt: now() + seconds(data.expires_in, 240) * 1000,
        nextPollAt: now() + intervalMs, intervalMs,
      } };
      doc.people ||= {};
      doc.people[personId] = next;
      await save(doc);
      return publicStatus(next);
    });
  }
  async function status(personId) {
    const identity = await expected(personId);
    if (!identity) return { linked: false, connected: false, pending: false, error: '当前账号尚未绑定飞书身份' };
    await accessToken(personId, identity);
    return queued(async () => {
      const doc = await document();
      const entry = doc.people?.[personId] || {};
      if (entry.token && (entry.token.openId !== identity.openId || entry.token.realm !== identity.realm)) {
        delete entry.token;
        delete entry.pending;
        entry.error = '当前飞书身份已变化，请重新授权';
        doc.people[personId] = entry;
        await save(doc);
        return publicStatus(entry);
      }
      const pending = entry.pending;
      if (!pending) return publicStatus(entry);
      if (pending.realm !== identity.realm || pending.expectedOpenId !== identity.openId || pending.expiresAt <= now()) {
        delete entry.pending;
        entry.error = '授权已过期，请重新连接';
        doc.people[personId] = entry;
        await save(doc);
        return publicStatus(entry);
      }
      if (pending.nextPollAt > now()) return publicStatus(entry);
      const app = await appFor(identity.realm);
      const response = await request(`${OPEN}/open-apis/authen/v2/oauth/token`, { form: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: pending.deviceCode,
        client_id: app.appId, client_secret: app.appSecret,
      } });
      const data = response.json;
      const error = clean(data.error);
      if (error === 'authorization_pending' || error === 'slow_down') {
        pending.intervalMs = error === 'slow_down' ? Math.min(60_000, pending.intervalMs + 5_000) : pending.intervalMs;
        pending.nextPollAt = now() + pending.intervalMs;
      } else if (response.ok && clean(data.access_token)) {
        const user = await request(`${OPEN}/open-apis/authen/v1/user_info`, { token: data.access_token });
        const actualOpenId = clean(user.json?.data?.open_id);
        if (!user.ok || actualOpenId !== identity.openId) {
          entry.error = '授权的飞书账号与当前 RemoteLab 账号不一致';
          delete entry.pending;
        } else {
          entry.token = { realm: identity.realm, openId: identity.openId, accessToken: data.access_token,
            refreshToken: clean(data.refresh_token), expiresAt: now() + seconds(data.expires_in, 7200) * 1000,
            refreshExpiresAt: now() + seconds(data.refresh_token_expires_in, 604800) * 1000,
            scope: clean(data.scope), grantedAt: now() };
          const missing = missingGrant(entry.token.scope);
          entry.error = missing.length ? `飞书未授予${missing.join('、')}权限，请重新授权` : '';
          delete entry.pending;
          cached.delete(personId);
          calendarCached.delete(personId);
          calendarRefreshing.delete(personId);
        }
      } else {
        entry.error = error === 'access_denied' ? '你已取消飞书授权' : error === 'expired_token' || error === 'invalid_grant'
          ? '授权已过期，请重新连接' : '飞书授权未完成，请重试';
        delete entry.pending;
      }
      doc.people[personId] = entry;
      await save(doc);
      return publicStatus(entry);
    });
  }
  async function accessToken(personId, identity) {
    return queued(async () => {
      const doc = await document();
      const entry = doc.people?.[personId];
      const token = entry?.token;
      if (!token || token.openId !== identity.openId || token.realm !== identity.realm) return null;
      if (token.expiresAt > now() + 5 * 60_000) return token.accessToken;
      if (entry.pending?.expiresAt > now()) return token.expiresAt > now() ? token.accessToken : null;
      if (!token.refreshToken || token.refreshExpiresAt <= now()) return null;
      const failed = refreshFailures.get(personId);
      if (failed?.until > now()) return token.expiresAt > now() ? token.accessToken : null;
      const app = await appFor(identity.realm);
      const response = await request(`${OPEN}/open-apis/authen/v2/oauth/token`, { data: {
        grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: app.appId, client_secret: app.appSecret,
      } });
      if (!response.ok || !clean(response.json.access_token)) {
        const code = clean(response.json.error) || `http_${response.status}`;
        refreshFailures.set(personId, { until: now() + (code === 'invalid_grant' ? 60_000 : 15_000) });
        if (token.expiresAt <= now()) {
          entry.error = code === 'invalid_grant' ? '飞书授权已失效，请重新连接' : '飞书令牌刷新失败，请重试连接';
          await save(doc);
        }
        console.warn(JSON.stringify({ event: 'display_feishu_refresh_failed', personId, code }));
        return token.expiresAt > now() ? token.accessToken : null;
      }
      refreshFailures.delete(personId);
      entry.error = '';
      entry.token = { ...token, accessToken: response.json.access_token,
        refreshToken: clean(response.json.refresh_token) || token.refreshToken,
        expiresAt: now() + seconds(response.json.expires_in, 7200) * 1000,
        refreshExpiresAt: now() + seconds(response.json.refresh_token_expires_in, 604800) * 1000 };
      await save(doc);
      return entry.token.accessToken;
    });
  }
  async function tenantToken(realm) {
    const saved = tenantTokens.get(realm);
    if (saved?.expiresAt > now() + 60_000) return saved.value;
    const app = await appFor(realm);
    const result = await request(`${OPEN}/open-apis/auth/v3/tenant_access_token/internal`, {
      data: { app_id: app.appId, app_secret: app.appSecret },
    });
    if (!result.ok || !clean(result.json.tenant_access_token)) return null;
    const value = result.json.tenant_access_token;
    tenantTokens.set(realm, { value, expiresAt: now() + seconds(result.json.expire, 7200) * 1000 });
    return value;
  }
  async function chatSourceInfo(realm, chatId, isP2p) {
    if (isP2p) return { label: '私聊对话', topic: false };
    if (!/^oc_[a-zA-Z0-9_-]{8,128}$/.test(chatId || '')) return { label: '飞书会话', topic: null };
    const key = `${realm}:${chatId}`;
    const saved = chatSources.get(key);
    if (saved?.expiresAt > now()) return saved.value;
    try {
      const token = await tenantToken(realm);
      if (!token) return { label: '群聊', topic: null };
      const result = await request(`${OPEN}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}?user_id_type=open_id`, { token });
      const chat = result.ok ? result.json?.data : null;
      if (!chat) return { label: '群聊', topic: null };
      if (chat.chat_mode === 'p2p') return { label: '私聊对话', topic: false };
      const name = clean(chat?.name).replace(/[\r\n\t]+/g, ' ').slice(0, 32);
      const topic = chat.chat_mode === 'topic' || chat.group_message_type === 'topic';
      const value = { label: name ? `${topic ? '话题群' : '群聊'} · ${name}` : '群聊', topic };
      chatSources.set(key, { value, expiresAt: now() + 60 * 60 * 1000 });
      return value;
    } catch { return { label: '群聊', topic: null }; }
  }
  async function chatSource(realm, chatId, isP2p) {
    return (await chatSourceInfo(realm, chatId, isP2p)).label;
  }
  async function messageDetails(token, ids) {
    const details = new Map();
    const valid = [...new Set(ids)].filter((id) => /^om_[a-zA-Z0-9_-]+$/.test(id || ''));
    for (let index = 0; index < valid.length; index += 50) {
      const url = new URL(`${OPEN}/open-apis/im/v1/messages/mget`);
      for (const id of valid.slice(index, index + 50)) url.searchParams.append('message_ids', id);
      const response = await request(url.toString(), { token });
      if (!response.ok || !Array.isArray(response.json?.data?.items)) break;
      for (const item of response.json.data.items) if (valid.includes(item?.message_id)) details.set(item.message_id, item);
    }
    return details;
  }
  async function readStatuses(token, pending) {
    const ids = pending.map((item) => item.messageId).filter((id) => /^om_[a-zA-Z0-9_-]+$/.test(id || ''));
    if (!ids.length) return { available: false, values: new Map() };
    const values = new Map();
    try {
      for (let index = 0; index < ids.length; index += 50) {
        const batch = ids.slice(index, index + 50);
        const result = await request(`${OPEN}/open-apis/im/v1/messages/read_status`, {
          token, data: { message_ids: batch },
        });
        if (!result.ok || !Array.isArray(result.json?.data?.items)) return { available: false, values: new Map() };
        for (const item of result.json.data.items) {
          if (typeof item?.is_read === 'boolean' && batch.includes(item.message_id)) values.set(item.message_id, item.is_read);
        }
      }
    } catch { return { available: false, values: new Map() }; }
    return { available: values.size === pending.length, values };
  }
  async function fetchCalendar(personId) {
    const identity = await expected(personId);
    if (!identity) return { available: false, authorizationRequired: true, events: [] };
    const token = await accessToken(personId, identity);
    const entry = (await document()).people?.[personId];
    if (!token || !hasCalendarScope(entry?.token?.scope)) return { available: false, authorizationRequired: true, events: [] };
    try {
      const primary = await request(`${OPEN}/open-apis/calendar/v4/calendars/primary`, { token });
      if (!primary.ok) return { available: false, authorizationRequired: primary.json?.code === 99991679, events: [] };
      const primaryData = primary.json?.data;
      const calendarId = clean(primaryData?.calendar_id) || clean(primaryData?.calendar?.calendar_id)
        || primaryData?.calendars?.find((item) => item?.calendar?.type === 'primary')?.calendar?.calendar_id
        || primaryData?.calendars?.[0]?.calendar?.calendar_id;
      if (!calendarId) throw new Error('Primary calendar missing');
      const start = Math.floor(now() / 1000) - 30 * 60;
      const end = start + 25 * 60 * 60;
      const url = new URL(`${OPEN}/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/instance_view`);
      url.searchParams.set('start_time', String(start));
      url.searchParams.set('end_time', String(end));
      const response = await request(url.toString(), { token });
      if (!response.ok) return { available: false, authorizationRequired: response.json?.code === 99991679, events: [] };
      // Feishu returns data: {} (without items) for an empty calendar window.
      const items = response.json?.data?.items ?? [];
      if (!Array.isArray(items)) throw new Error('Calendar events unavailable');
      const events = items.filter((item) => item?.status !== 'cancelled'
        && !['decline', 'removed'].includes(item?.self_rsvp_status)).map((item) => {
        const allDay = Boolean(item?.start_time?.date && !item?.start_time?.timestamp);
        const startAt = allDay ? Date.parse(`${item.start_time.date.slice(0, 10)}T09:00:00+08:00`)
          : Number(item?.start_time?.timestamp) * 1000;
        return { id: clean(item?.event_id), title: clean(item?.summary).slice(0, 48) || '未命名日程', startAt, allDay };
      }).filter((item) => item.id && Number.isFinite(item.startAt)).sort((a, b) => a.startAt - b.startAt);
      return { available: true, authorizationRequired: false, events, observedAt: new Date(now()).toISOString() };
    } catch { return { available: false, authorizationRequired: false, events: [] }; }
  }
  function calendarLatest(personId) {
    const saved = calendarCached.get(personId);
    if ((!saved || saved.expiresAt <= now()) && !calendarRefreshing.has(personId)) {
      const task = fetchCalendar(personId).catch(() => ({ available: false, authorizationRequired: false, events: [] })).then((value) => {
        if (calendarRefreshing.get(personId) === task) calendarCached.set(personId, { value, expiresAt: now() + (value.available ? 60_000 : 15_000) });
        return value;
      }).finally(() => { if (calendarRefreshing.get(personId) === task) calendarRefreshing.delete(personId); });
      calendarRefreshing.set(personId, task);
    }
    const value = saved?.value || { available: false, authorizationRequired: false, events: [] };
    const due = (value.events || []).filter((item) => item.startAt - 30 * 60_000 <= now()
      && item.startAt + 10 * 60_000 > now()).slice(0, 3);
    const next = (value.events || []).find((item) => item.startAt > now());
    return { available: value.available, authorizationRequired: value.authorizationRequired,
      due, next: next || null, observedAt: value.observedAt || null };
  }
  async function calendarSummary(personId) {
    calendarLatest(personId);
    await calendarRefreshing.get(personId);
    return calendarLatest(personId);
  }
  async function fetchSummary(personId) {
    const identity = await expected(personId);
    if (!identity) return { connected: false, available: false, recentMessages: 0, mentions24h: 0 };
    const token = await accessToken(personId, identity);
    if (!token) return { connected: false, available: false, recentMessages: 0, mentions24h: 0 };
    const grantAt = (await document()).people?.[personId]?.token?.grantedAt;
    const saved = cached.get(personId);
    if (saved?.expiresAt > now()) return saved.value;
    // Feishu's search schema requires a timezone offset and whole seconds.
    // Date#toISOString() emits milliseconds and Z, which this endpoint rejects.
    const timeRange = { start_time: feishuTime(now() - 24 * 60 * 60 * 1000), end_time: feishuTime(now()) };
    const search = async (filter) => request(`${OPEN}/open-apis/im/v1/messages/search?page_size=50`, {
      token, data: { query: '', filter: { time_range: timeRange, ...filter } },
    });
    try {
      const [all, mentions] = await Promise.all([search({}), search({ is_at_me: true })]);
      if (!all.ok || !mentions.ok || !Array.isArray(all.json?.data?.items) || !Array.isArray(mentions.json?.data?.items)) throw new Error('Feishu search unavailable');
      const identityKey = messageKey(`${identity.realm}:${identity.openId}`);
      const incoming = all.json.data.items.filter((item) => item?.meta_data?.from_id !== identity.openId);
      const incomingKeys = incoming.map((item) => ({ messageId: item?.meta_data?.message_id || item?.id,
        chatId: item?.meta_data?.chat_id || null,
        chatKey: item?.meta_data?.chat_id ? messageKey(item.meta_data.chat_id) : null,
        isP2p: item?.meta_data?.is_p2p_chat === true, createdAt: messageTime(item?.meta_data?.create_time) }))
        .filter((item) => item.messageId).map((item) => ({ ...item, id: messageKey(item.messageId) }));
      const incomingByKey = new Map(incomingKeys.map((item) => [item.id, item]));
      const mentionKeys = new Set(mentions.json.data.items.map((item) => item?.meta_data?.message_id || item?.id).filter(Boolean).map(messageKey));
      const notifications = await queued(async () => {
        const doc = await readJson(notificationFile, { version: 1, people: {} });
        const prior = doc.people?.[personId];
        const sameIdentity = prior?.identityKey === identityKey;
        const current = sameIdentity ? prior : { identityKey, known: [], pending: [], initializedAt: now(), policyVersion: 2 };
        current.initializedAt ||= now();
        const newPolicy = sameIdentity && current.policyVersion !== 2;
        const newGrant = sameIdentity && Number.isFinite(grantAt) && grantAt > (current.grantBaselineAt || 0);
        const known = new Set(current.known || []);
        const dismissed = new Set(current.dismissed || []);
        // Retain arrivals across refreshes; the recipient's actual read state below
        // clears them after they are read in Feishu.
        let pending = (current.pending || []).map((item) => {
          const match = incomingByKey.get(item.id);
          const { senderId: _senderId, ...saved } = item;
          return match ? { ...saved, messageId: saved.messageId || match.messageId,
            chatId: saved.chatId || match.chatId, isP2p: saved.isP2p ?? match.isP2p } : saved;
        });
        const candidates = new Map([
          ...pending.map((item) => [item.id, item]),
          ...incomingKeys.map((item) => [item.id, item]),
        ]);
        const chatIds = [...new Set([...candidates.values()].filter((item) => !item.isP2p)
          .map((item) => item.chatId).filter(Boolean))];
        const chatInfo = new Map(await Promise.all(chatIds.map(async (chatId) => [chatId,
          await chatSourceInfo(identity.realm, chatId, false)])));
        const topicMode = (item) => item.isP2p ? false : (chatInfo.get(item.chatId)?.topic ?? item.topicMode);
        // A topic-mode chat contains both top-level messages and replies. The
        // latter are identified by parent_id, including in ordinary group chats.
        const groupCandidates = [...candidates.values()].filter((item) => !item.isP2p);
        const details = await messageDetails(token, groupCandidates.map((item) => item.messageId));
        if (groupCandidates.some((item) => !details.has(item.messageId))) throw new Error('Feishu message details unavailable');
        const actionable = new Map([...candidates.values()].map((item) => {
          if (item.isP2p) return [item.id, { allowed: true, atMe: Boolean(item.atMe || mentionKeys.has(item.id)) }];
          const detail = details.get(item.messageId);
          const isReply = Boolean(detail?.parent_id);
          const atMe = isReply
            ? detail?.mentions?.some((mention) => mention.id === identity.openId) === true
            : Boolean(mentionKeys.has(item.id));
          return [item.id, { allowed: !isReply || atMe, atMe }];
        }));
        pending = pending.filter((item) => actionable.get(item.id)?.allowed === true)
          .map((item) => ({ ...item, atMe: actionable.get(item.id)?.atMe ?? item.atMe,
            topicMode: topicMode(item) }));
        // A new user grant is a new observation boundary. Search may return messages
        // from the disconnected interval, including ones read before reconnecting.
        // Keep an audit of that backfill instead of presenting it as new mail.
        const historical = newGrant ? [...new Map([
          ...incomingKeys.filter((item) => !known.has(item.id) && Number.isFinite(item.createdAt)
            && item.createdAt < grantAt && actionable.get(item.id)?.allowed === true),
          ...pending.filter((item) => Number.isFinite(item.createdAt) && item.createdAt < grantAt),
        ].map((item) => [item.id, item])).values()] : [];
        const historicalRead = await readStatuses(token, historical);
        const reconciled = new Map((current.reconciled || []).map((item) => [item.id, item]));
        if (!sameIdentity || newPolicy) for (const item of incomingKeys) reconciled.set(item.id, {
          id: item.id, createdAt: item.createdAt, observedAt: now(), reconciledAt: now(),
          reason: newPolicy ? 'policy_baseline' : 'initial_baseline', apiIsRead: null,
        });
        for (const item of historical) reconciled.set(item.id, {
          id: item.id, createdAt: item.createdAt, observedAt: item.observedAt || now(),
          reconciledAt: now(), reason: 'reconnect_backfill',
          apiIsRead: historicalRead.values.get(item.messageId) ?? null,
        });
        if (newGrant) pending = pending.filter((item) => !reconciled.has(item.id));
        const read = await readStatuses(token, [...candidates.values()].length
          ? [...candidates.values()] : incomingKeys.slice(0, 1));
        if (sameIdentity && !newPolicy) {
          const pendingIds = new Set(pending.map((item) => item.id));
          for (const item of incomingKeys) if (!pendingIds.has(item.id)
            && (!known.has(item.id) || read.values.get(item.messageId) === false)
            && actionable.get(item.id)?.allowed === true
            && !reconciled.has(item.id)
            && !dismissed.has(item.id)
            && (!Number.isFinite(item.createdAt) || item.createdAt >= current.initializedAt - 2_000)
            && (!Number.isFinite(grantAt) || Number.isFinite(item.createdAt) && item.createdAt >= grantAt)) {
            pending.push({ id: item.id, messageId: item.messageId, chatId: item.chatId,
              chatKey: item.chatKey, isP2p: item.isP2p, topicMode: topicMode(item), createdAt: item.createdAt,
              atMe: actionable.get(item.id).atMe, observedAt: now() });
            pendingIds.add(item.id);
          }
        }
        // Only this message's read receipt can clear it. A later read message
        // or an outgoing reply in the same chat says nothing about this one.
        pending = pending.filter((item) => read.values.get(item.messageId) !== true);
        for (const item of incomingKeys) if (newPolicy || item.isP2p || details.has(item.messageId)) known.add(item.id);
        doc.people ||= {};
        doc.people[personId] = { identityKey, initializedAt: current.initializedAt,
          policyVersion: 2,
          grantBaselineAt: Number.isFinite(grantAt) ? grantAt : current.grantBaselineAt,
          known: [...known].slice(-1000), pending: pending.slice(-1000),
          dismissed: [...dismissed].slice(-1000),
          reconciled: [...reconciled.values()].slice(-1000) };
        await saveNotifications(doc);
        return { ...doc.people[personId], readStateAvailable: read.available };
      });
      const newest = [...notifications.pending].sort((a, b) => (b.createdAt || b.observedAt) - (a.createdAt || a.observedAt));
      const chats = new Map();
      for (const item of newest) {
        const key = item.chatId || item.chatKey || item.id;
        const group = chats.get(key) || { chatId: item.chatId, isP2p: item.isP2p, count: 0 };
        group.count += 1;
        chats.set(key, group);
      }
      const sources = await Promise.all([...chats.values()].slice(0, 3).map(async (group) => ({
        label: await chatSource(identity.realm, group.chatId, group.isP2p), count: group.count,
      })));
      const value = { connected: true, available: true, recentMessages: incoming.length,
        mentions24h: mentions.json.data.items.length,
        newMessages: notifications.pending.length, newMentions: notifications.pending.filter((item) => item.atMe).length,
        readStateAvailable: notifications.readStateAvailable, sources,
        recentTruncated: Boolean(all.json.data.has_more), mentionsTruncated: Boolean(mentions.json.data.has_more),
        truncated: Boolean(all.json.data.has_more || mentions.json.data.has_more), observedAt: new Date(now()).toISOString(),
        calendar: calendarLatest(personId) };
      cached.set(personId, { value, expiresAt: now() + 1_000 });
      return value;
    } catch {
      return { connected: true, available: false, recentMessages: 0, mentions24h: 0 };
    }
  }
  function summary(personId) {
    const saved = cached.get(personId);
    if (saved?.expiresAt > now()) return Promise.resolve(saved.value);
    const pending = refreshing.get(personId);
    if (pending) return pending;
    const task = fetchSummary(personId).finally(() => refreshing.delete(personId));
    refreshing.set(personId, task);
    return task;
  }
  function latest(personId) {
    const saved = cached.get(personId);
    if (!saved || saved.expiresAt <= now()) void summary(personId).catch(() => {});
    const calendar = calendarLatest(personId);
    if (saved && saved.expiresAt > now() - 10_000) return { ...saved.value, calendar };
    return { connected: false, available: false, recentMessages: 0, mentions24h: 0, calendar };
  }
  async function acknowledge(personId, through) {
    const throughMs = Date.parse(through || '');
    if (!Number.isFinite(throughMs) || throughMs > now() + 1_000) throw Object.assign(new Error('Invalid reminder snapshot'), { status: 400 });
    const identity = await expected(personId);
    if (!identity || !await accessToken(personId, identity)) return { connected: false, cleared: 0 };
    return queued(async () => {
      const doc = await readJson(notificationFile, { version: 1, people: {} });
      const current = doc.people?.[personId];
      const identityKey = messageKey(`${identity.realm}:${identity.openId}`);
      if (!current || current.identityKey !== identityKey) return { connected: true, cleared: 0 };
      const removed = (current.pending || []).filter((item) => item.observedAt <= throughMs);
      const cleared = removed.length;
      current.dismissed = [...new Set([...(current.dismissed || []), ...removed.map((item) => item.id)])].slice(-1000);
      current.pending = (current.pending || []).filter((item) => item.observedAt > throughMs);
      await saveNotifications(doc);
      cached.delete(personId);
      return { connected: true, cleared };
    });
  }
  async function maintain() {
    const doc = await document();
    for (const [personId, entry] of Object.entries(doc.people || {})) {
      if (!entry?.token?.refreshToken || entry.token.expiresAt > now() + 5 * 60_000) continue;
      try {
        const identity = await expected(personId);
        if (identity) await accessToken(personId, identity);
      } catch (error) {
        console.warn(JSON.stringify({ event: 'display_feishu_maintenance_failed', personId, code: clean(error?.code) || 'unavailable' }));
      }
    }
  }
  return { begin, status, summary, latest, calendarSummary, acknowledge, maintain };
}
