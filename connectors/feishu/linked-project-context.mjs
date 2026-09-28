import { open } from 'node:fs/promises';

const MAX_EVENT_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARACTERS = 3600;
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
    if (!projectId || !discussionChatId || !workChatId || discussionChatId === workChatId) {
      throw new Error('Each projectLink needs a projectId and two distinct chat IDs');
    }
    if (usedChats.has(discussionChatId) || usedChats.has(workChatId)) {
      throw new Error('A Feishu chat cannot belong to multiple projectLinks');
    }
    usedChats.add(discussionChatId);
    usedChats.add(workChatId);
    return { projectId, discussionChatId, discussionChatName, workChatId };
  });
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
  const currentTime = parseTime(current?.createTime) || Date.now();
  const maxAgeMs = options.maxAgeMs || MAX_CONTEXT_AGE_MS;
  const latestById = new Map();
  for (const line of String(eventText || '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event?.summary;
    const messageId = trimString(item?.messageId);
    if (event?.allowed !== true || item?.chatId !== link.discussionChatId || !messageId) continue;
    if (trimString(item?.sender?.senderType).toLowerCase() !== 'user') continue;
    const timestamp = parseTime(item.createTime) || parseTime(event.receivedAt);
    if (!timestamp || timestamp >= currentTime || currentTime - timestamp > maxAgeMs) continue;
    const text = trimString(item.messageText || item.textPreview);
    if (!text) continue;
    latestById.set(messageId, {
      messageId,
      timestamp,
      text: text.slice(0, MAX_MESSAGE_CHARACTERS),
      threadId: trimString(item.threadId),
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
  const link = runtime?.config?.projectLinks?.find((entry) => entry.workChatId === summary?.chatId);
  if (!link) return null;
  const events = await readEventTail(runtime?.storagePaths?.eventsLogPath);
  const messages = selectLinkedFeishuMessages(events, link, summary);
  return messages.length ? {
    projectId: link.projectId,
    sourceChatId: link.discussionChatId,
    sourceChatName: link.discussionChatName,
    messages,
  } : null;
}
