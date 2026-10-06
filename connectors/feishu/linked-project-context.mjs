import { createHash } from 'node:crypto';
import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { feishuParticipantKey, feishuParticipantLabel } from './participant-attribution.mjs';

const MAX_EVENT_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CONTEXT_MESSAGES = 20;
const MAX_CONTEXT_CHARACTERS = 6000;
const MAX_MESSAGE_CHARACTERS = 900;

const trimString = value => typeof value === 'string' ? value.trim() : '';

export function normalizeFeishuProjectLinks(value = []) {
  if (!Array.isArray(value)) throw new Error('projectLinks must be an array');
  const usedChats = new Set();
  return value.map((entry) => {
    const projectId = trimString(entry?.projectId);
    const discussionChatId = trimString(entry?.discussionChatId);
    const discussionChatName = trimString(entry?.discussionChatName);
    const workChatId = trimString(entry?.workChatId);
    const workChatName = trimString(entry?.workChatName);
    if (entry?.workToDiscussionContext !== undefined && entry.workToDiscussionContext !== ''
      && entry.workToDiscussionContext !== 'full') {
      throw new Error('projectLink workToDiscussionContext must be full when enabled');
    }
    if (entry?.handoffCards !== undefined && typeof entry.handoffCards !== 'boolean') {
      throw new Error('projectLink handoffCards must be a boolean');
    }
    const handoffCards = entry?.handoffCards === true;
    if (!projectId || !discussionChatId || !workChatId || discussionChatId === workChatId) {
      throw new Error('Each projectLink needs a projectId and two distinct chat IDs');
    }
    if (usedChats.has(discussionChatId) || usedChats.has(workChatId)) {
      throw new Error('A Feishu chat cannot belong to multiple projectLinks');
    }
    usedChats.add(discussionChatId);
    usedChats.add(workChatId);
    return { projectId, discussionChatId, discussionChatName, workChatId, workChatName,
      workToDiscussionContext: entry?.workToDiscussionContext || '', handoffCards };
  });
}

function linkedSource(link, currentChatId) {
  if (currentChatId === link.workChatId) return {
    chatId: link.discussionChatId, chatName: link.discussionChatName,
  };
  if (currentChatId === link.discussionChatId && link.workToDiscussionContext === 'full') return {
    chatId: link.workChatId, chatName: link.workChatName,
  };
  return null;
}

function projectStreamPath(runtime, projectId) {
  const root = trimString(runtime?.config?.storageDir);
  if (!root) return '';
  const key = createHash('sha256').update(projectId).digest('hex').slice(0, 24);
  return join(root, 'project-message-streams', `${key}.jsonl`);
}

// The connector event log remains the audit trail. This smaller project stream
// keeps recent linked messages readable when unrelated chats fill its tail.
export async function appendLinkedFeishuProjectEvent(runtime, record) {
  const summary = record?.summary;
  if (record?.allowed !== true || trimString(summary?.sender?.senderType).toLowerCase() !== 'user') return false;
  const link = runtime?.config?.projectLinks?.find(entry =>
    entry.discussionChatId === summary?.chatId || entry.workChatId === summary?.chatId);
  if (!link || !trimString(summary?.messageId)) return false;
  const path = projectStreamPath(runtime, link.projectId);
  if (!path) return false;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify({
    receivedAt: record.receivedAt, allowed: true,
    summary: {
      chatId: summary.chatId, messageId: summary.messageId,
      createTime: summary.createTime, threadId: summary.threadId,
      messageText: trimString(summary.messageText || summary.textPreview).slice(0, MAX_MESSAGE_CHARACTERS),
      sender: { senderType: 'user', name: trimString(summary.sender.name),
        openId: trimString(summary.sender.openId), userId: trimString(summary.sender.userId), unionId: trimString(summary.sender.unionId),
        realm: trimString(runtime.config.sourceRouteId),
        participantKey: feishuParticipantKey(summary.sender) },
    },
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  return true;
}

export async function appendLinkedFeishuProjectDelivery(runtime, receipt) {
  if (receipt?.kind !== 'content' || !trimString(receipt?.messageId)
    || !trimString(receipt?.text)) return false;
  const chatId = trimString(receipt?.target?.chatId);
  const link = runtime?.config?.projectLinks?.find(entry =>
    entry.discussionChatId === chatId || entry.workChatId === chatId);
  if (!link) return false;
  const path = projectStreamPath(runtime, link.projectId);
  if (!path) return false;
  const at = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify({
    receivedAt: at, allowed: true, outbound: true,
    summary: {
      chatId, messageId: receipt.messageId, createTime: at,
      threadId: trimString(receipt.threadId || receipt.target?.threadId),
      messageText: trimString(receipt.text).slice(0, MAX_MESSAGE_CHARACTERS),
      sender: { senderType: 'app', name: '群内 Bot' },
    },
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  return true;
}

function parseTime(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readEventTail(pathname, maxBytes = MAX_EVENT_TAIL_BYTES) {
  if (!pathname) return '';
  let handle;
  try {
    handle = await open(pathname, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const body = buffer.subarray(0, bytesRead).toString('utf8');
    return start ? body.slice(body.indexOf('\n') + 1) : body;
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  } finally {
    await handle?.close();
  }
}

export function selectLinkedFeishuMessages(eventText, link, current, options = {}) {
  const source = linkedSource(link, current?.chatId);
  if (!source) return [];
  const currentTime = parseTime(current?.createTime) || Date.now();
  const maxAgeMs = options.maxAgeMs || MAX_CONTEXT_AGE_MS;
  const latestById = new Map();
  for (const line of String(eventText || '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event?.summary;
    const messageId = trimString(item?.messageId);
    if (event?.allowed !== true || item?.chatId !== source.chatId || !messageId) continue;
    const senderType = trimString(item?.sender?.senderType).toLowerCase();
    if (senderType !== 'user' && !(event.outbound === true && senderType === 'app')) continue;
    const timestamp = parseTime(item.createTime) || parseTime(event.receivedAt);
    if (!timestamp || timestamp >= currentTime || currentTime - timestamp > maxAgeMs) continue;
    const text = trimString(item.messageText || item.textPreview);
    if (!text) continue;
    const previous = latestById.get(messageId);
    const identified = trimString(item.sender?.name) || feishuParticipantKey(item.sender)
      || senderType === 'app';
    latestById.set(messageId, {
      messageId,
      timestamp,
      text: text.slice(0, MAX_MESSAGE_CHARACTERS),
      threadId: trimString(item.threadId),
      sender: identified ? feishuParticipantLabel(item.sender)
        : previous?.sender || feishuParticipantLabel(item.sender),
      authorRef: item.sender ? { ...item.sender, kind: 'feishu' } : previous?.authorRef,
    });
  }

  const selected = [...latestById.values()]
    .sort((a, b) => (b.timestamp - a.timestamp) || b.messageId.localeCompare(a.messageId));
  const messages = [];
  let characters = 0;
  for (const message of selected) {
    if (messages.length >= MAX_CONTEXT_MESSAGES) break;
    const cost = message.text.length + 120;
    if (characters + cost > MAX_CONTEXT_CHARACTERS) continue;
    messages.push(message);
    characters += cost;
  }
  return messages.reverse();
}

export async function loadLinkedFeishuProjectContext(runtime, summary) {
  const link = runtime?.config?.projectLinks?.find((entry) => linkedSource(entry, summary?.chatId));
  if (!link) return null;
  const source = linkedSource(link, summary.chatId);
  const [legacyEvents, projectEvents] = await Promise.all([
    readEventTail(runtime?.storagePaths?.eventsLogPath),
    readEventTail(projectStreamPath(runtime, link.projectId)),
  ]);
  const events = `${legacyEvents}\n${projectEvents}`;
  const messages = selectLinkedFeishuMessages(events, link, summary);
  return messages.length ? {
    projectId: link.projectId,
    sourceChatId: source.chatId,
    sourceChatName: source.chatName,
    messages,
  } : null;
}
