import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createConnectorInbox } from '../../lib/connector-inbox.mjs';
import { createRecordStore } from '../../lib/durable-records.mjs';

const ADDED = 'im.chat.member.user.added_v1';
const DELETED = 'im.chat.member.user.deleted_v1'; // Includes voluntary departure.
const WITHDRAWN = 'im.chat.member.user.withdrawn_v1'; // Invitation revoked.
const str = value => typeof value === 'string' ? value.trim() : '';
const key = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const projectMemberChatIds = link => [...new Set([
  link.discussionChatId, link.workChatId, ...(link.chatIds || []),
].filter(Boolean))];

export function normalizeProjectMemberSync(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isFinite(Date.parse(value.notBefore))) throw new Error('projectMemberSync requires notBefore');
  return { notBefore: new Date(value.notBefore).toISOString(), initialSyncId: str(value.initialSyncId) };
}

function eventTime(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? (n < 1e11 ? n * 1000 : n) : Date.parse(value);
}

// Event-driven additions only. A recorded departure fences older invitations;
// there is no periodic union reconciliation and no removal API in this module.
export function createProjectMemberSync(runtime, options = {}) {
  const policy = runtime.config.projectMemberSync;
  const links = (runtime.config.projectLinks || []).filter(link => link.memberSync === true);
  const root = join(runtime.config.storageDir, 'project-member-sync');
  const members = createRecordStore(join(root, 'members'));
  const request = options.request || (args => runtime.appClient.request(args));
  const now = options.now || Date.now;
  const onError = options.onError || (error => console.error(`[project-member-sync] ${error.message}`));
  const findLink = projectId => links.find(link => link.projectId === projectId);
  const memberKey = (projectId, userId) => key(`${projectId}:${userId}`);
  const enabled = Boolean(policy && links.length);

  async function api(args) {
    const response = await request(args);
    if (response?.code !== 0) throw new Error(`Feishu membership API ${response?.code ?? 'invalid response'}: ${response?.msg || ''}`);
    return response.data;
  }
  async function list(chatId) {
    const ids = new Set(), pages = new Set(); let pageToken;
    do {
      const data = await api({ method: 'GET', url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`,
        params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } });
      if (!Array.isArray(data?.items) || data.trigger_security_conf_limit) throw new Error('Incomplete project member list');
      for (const item of data.items) {
        if (!str(item.member_id) || item.member_id_type !== 'open_id') throw new Error('Invalid project member identity');
        ids.add(item.member_id);
      }
      if (data.has_more === false) break;
      pageToken = str(data.page_token);
      if (data.has_more !== true || !pageToken || pages.has(pageToken)) throw new Error('Incomplete project member pagination');
      pages.add(pageToken);
    } while (true);
    return ids;
  }
  async function departed(projectId, userId, chatId, at, initial) {
    const state = await members.get(memberKey(projectId, userId));
    const left = state?.departures?.[chatId];
    return Boolean(left && (initial || left.at >= at));
  }
  async function process(entry, update) {
    if (entry.echo) return { ignored: 'sync_echo' };
    const link = findLink(entry.projectId);
    if (!enabled || !link) return { ignored: 'disabled' };
    const chats = projectMemberChatIds(link);
    // A recovered event must not broaden its original target set after a config edit.
    const targets = (entry.chatIds || []).filter(id => chats.includes(id));
    if (!entry.initial && !targets.includes(entry.chatId)) return { ignored: 'source_unbound' };
    let roster = entry.roster;
    if (!roster) {
      if (entry.initial) {
        const snapshots = await Promise.all(targets.map(async chatId => ({ chatId, ids: [...await list(chatId)] })));
        roster = [...new Set(snapshots.flatMap(snapshot => snapshot.ids))];
        await update({ roster, snapshots });
      } else {
        roster = [];
        for (const userId of entry.userIds) {
          const state = entry.operatorId === runtime.botIdentity?.openId
            ? await members.get(memberKey(entry.projectId, userId)) : null;
          if (!state?.invitations?.[entry.chatId]) roster.push(userId);
        }
        await update({ roster });
      }
    }
    if (!roster.length) return { ignored: 'sync_echo_or_empty' };
    // Check the current source after restart/delay. An old join must not revive a leaver.
    const source = entry.initial ? null : await list(entry.chatId);
    const operations = { ...entry.operations };
    const save = () => update({ operations });
    for (const chatId of targets) {
      if (chatId === entry.chatId) continue;
      let existing;
      try { existing = await list(chatId); }
      catch (error) { operations[chatId] = { ...operations[chatId], readError: error.message }; await save(); throw error; }
      const results = { ...operations[chatId]?.members };
      const candidates = [];
      for (const userId of roster) {
        if (results[userId]?.attempted || results[userId]?.status === 'present') {
          // Never issue the same invitation twice, including after uncertain writes.
          results[userId] = { ...results[userId], status: existing.has(userId) ? 'present' : results[userId].status };
          continue;
        }
        if (existing.has(userId)) { results[userId] = { status: 'present' }; continue; }
        if ((source && !source.has(userId)) || await departed(entry.projectId, userId, entry.chatId, entry.at, false)
          || await departed(entry.projectId, userId, chatId, entry.at, entry.initial)) {
          results[userId] = { status: 'departure_respected' }; continue;
        }
        candidates.push(userId);
      }
      operations[chatId] = { members: results }; await save();
      for (let offset = 0; offset < candidates.length; offset += 50) {
        const ids = [];
        for (const userId of candidates.slice(offset, offset + 50)) {
          if (await departed(entry.projectId, userId, chatId, entry.at, entry.initial)
            || (!entry.initial && await departed(entry.projectId, userId, entry.chatId, entry.at, false))) {
            results[userId] = { status: 'departure_respected' };
          } else ids.push(userId);
        }
        if (!ids.length) { await save(); continue; }
        for (const userId of ids) results[userId] = { attempted: true, status: 'uncertain', attemptedAt: now() };
        await save(); // Persist before the external side effect.
        for (const userId of ids) await members.mutate(memberKey(entry.projectId, userId), current => ({
          ...current, projectId: entry.projectId, userId, invitations: { ...current?.invitations,
            [chatId]: { at: results[userId].attemptedAt, cause: entry.id } },
        }));
        try {
          const receipt = await api({ method: 'POST', url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`,
            params: { member_id_type: 'open_id', succeed_type: 1 }, data: { id_list: ids } });
          const invalid = new Set([...(receipt?.invalid_id_list || []), ...(receipt?.not_existed_id_list || [])]);
          const pending = new Set(receipt?.pending_approval_id_list || []);
          for (const userId of ids) results[userId].status = invalid.has(userId) ? 'invalid'
            : pending.has(userId) ? 'pending_approval' : 'unverified';
          operations[chatId].receipt = receipt;
        } catch (error) { operations[chatId].writeError = error.message; }
        await save();
        try {
          const after = await list(chatId);
          for (const userId of ids) if (after.has(userId)) results[userId].status = 'present';
        } catch (error) { operations[chatId].readError = error.message; }
        await save();
      }
    }
    const unresolved = Object.entries(operations).flatMap(([chatId, operation]) =>
      Object.entries(operation.members || {}).filter(([, value]) => !['present', 'departure_respected'].includes(value.status))
        .map(([userId, value]) => ({ chatId, userId, ...value })));
    if (unresolved.length) onError(new Error(`${entry.projectId}: ${unresolved.length} member invitations unresolved; see ${root}`));
    return { projectId: entry.projectId, complete: unresolved.length === 0, unresolved, operations };
  }
  const inbox = createConnectorInbox(join(root, 'inbox'), {
    process, conversationKey: entry => entry.projectId, onError,
    retryPolicy: () => ({ maxAttempts: 3, delayMs: 2000 }),
  });
  async function accept(type, raw) {
    if (!enabled) return {};
    const event = raw?.event || raw;
    const link = links.find(link => projectMemberChatIds(link).includes(event.chat_id));
    if (!link) return {};
    const id = str(raw.header?.event_id || event.event_id);
    const at = eventTime(raw.header?.create_time || event.create_time);
    const userIds = [...new Set((event.users || []).map(user => str(user.user_id?.open_id)).filter(Boolean))];
    if (!id || !Number.isFinite(at) || at < Date.parse(policy.notBefore) || !userIds.length) return {};
    if (type !== ADDED) {
      // Apply departure fences immediately, even while a project addition is running.
      for (const userId of userIds) await members.mutate(memberKey(link.projectId, userId), current => {
        if ((current?.departures?.[event.chat_id]?.at || 0) >= at) return current;
        const invitations = { ...current?.invitations };
        if (at >= (invitations[event.chat_id]?.at || 0)) delete invitations[event.chat_id];
        return { ...current, projectId: link.projectId, userId, invitations, departures: { ...current?.departures,
          [event.chat_id]: { at, eventId: id, type, operatorId: str(event.operator_id?.open_id) } } };
      });
      return {};
    }
    const operatorId = str(event.operator_id?.open_id);
    // Suppress only invitations made by this synchronizer. An unrelated action
    // by the same Bot is also a valid new join and must propagate normally.
    if (!operatorId || !runtime.botIdentity?.openId) return {};
    await inbox.accept(`${type}:${id}`, { projectId: link.projectId, chatId: event.chat_id,
      chatIds: projectMemberChatIds(link), userIds, at, eventId: id, operatorId, initial: false });
    return {};
  }
  return {
    handlers: Object.fromEntries([ADDED, DELETED, WITHDRAWN].map(type => [type, raw => accept(type, raw)])),
    async start() {
      if (!enabled) return;
      if (policy.initialSyncId) for (const link of links) {
        const id = `initial:${policy.initialSyncId}:${link.projectId}`;
        if (await inbox.store.get(key(id))) continue;
        await inbox.accept(id, {
          projectId: link.projectId, chatIds: projectMemberChatIds(link), initial: true,
          at: Date.parse(policy.notBefore),
        });
      }
      inbox.start();
    },
    stop: inbox.stop, idle: inbox.idle, inbox, members, list,
  };
}
