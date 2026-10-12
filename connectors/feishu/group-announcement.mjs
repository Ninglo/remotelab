import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createKeyedTaskQueue, readJson, writeJsonAtomic } from '../../chat/fs-utils.mjs';
import { withTimeout } from '../../lib/connector-driver-transports.mjs';
import { buildFeishuTopicId, isFeishuDocumentCommentSummary } from './index.mjs';

const serial = createKeyedTaskQueue();
const MAX_TEXT = 16000;
const MAX_PAGES = 10;
const trim = value => typeof value === 'string' ? value.trim() : '';

function elementText(element) {
  if (element.text_run) {
    const run = element.text_run;
    const url = run.text_element_style?.link?.url;
    return `${run.content || ''}${url ? ` (${url})` : ''}`;
  }
  if (element.mention_doc) return [element.mention_doc.title, element.mention_doc.url].filter(Boolean).join(' ') || '[文档引用]';
  if (element.mention_user) return '[成员提及]';
  if (element.equation) return element.equation.content || '';
  return '[未解析的富文本元素]';
}

export function announcementBlockText(block) {
  const payload = Object.values(block).find(value => Array.isArray(value?.elements));
  if (payload) return payload.elements.map(elementText).join('');
  if ([1, 19, 24, 31, 32].includes(block.block_type)) return ''; // structural containers
  return `[非文本公告块：${block.block_type}，需按需读取原公告]`;
}

// Legacy announcements return a serialized document, not plain text.
export function legacyAnnouncementText(content) {
  const doc = typeof content === 'string' ? JSON.parse(content || '{}') : content;
  const walk = value => {
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) return value.map(walk).filter(Boolean).join('\n');
    if (value.textRun) return `${value.textRun.text || ''}${value.textRun.style?.link?.url ? ` (${value.textRun.style.link.url})` : ''}`;
    if (value.text_run) return elementText(value);
    if (Array.isArray(value.elements)) return value.elements.map(walk).join('');
    if (value.type === 'image') return '[图片，需按需读取原公告]';
    return Object.values(value).map(walk).filter(Boolean).join('\n');
  };
  return [trim(doc?.title), walk(doc?.body || doc)].filter(Boolean).join('\n');
}

export async function loadFeishuGroupAnnouncement(runtime, summary) {
  const fetchedAt = new Date().toISOString();
  const path = { chat_id: summary.chatId };
  const deadline = Date.now() + (runtime.config?.apiTimeoutMs || 10000);
  const call = async (resource, method, payload) => {
    if (typeof resource?.[method] !== 'function') throw Object.assign(new Error('Announcement API unavailable'), { code: 'unsupported_client' });
    const response = await withTimeout(() => resource[method](payload), Math.max(1, deadline - Date.now()), 'Feishu group announcement');
    if (response?.code) throw Object.assign(new Error('Announcement read failed'), { code: response.code });
    return response?.data || {};
  };
  try {
    const docx = runtime.appClient?.docx?.v1;
    const meta = await call(docx?.chatAnnouncement, 'get', { path });
    let text = '', truncated = false;
    if (meta.announcement_type === 'doc') {
      const legacy = await call(runtime.appClient?.im?.v1?.chatAnnouncement, 'get', { path });
      text = legacyAnnouncementText(legacy.content);
    } else if (meta.announcement_type === 'docx') {
      let pageToken = '';
      const lines = [], seen = new Set();
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await call(docx.chatAnnouncementBlock, 'list', { path, params: {
          page_size: 500, revision_id: -1, ...(pageToken ? { page_token: pageToken } : {}),
        } });
        for (const block of data.items || []) {
          if (seen.has(block.block_id)) continue;
          seen.add(block.block_id);
          lines.push(announcementBlockText(block));
        }
        text = lines.filter(Boolean).join('\n');
        if (!data.has_more) break;
        if (!data.page_token || page === MAX_PAGES - 1 || text.length > MAX_TEXT) { truncated = true; break; }
        pageToken = data.page_token;
      }
      // Latest-version reads need only read permission. Detect edits during pagination.
      const after = await call(docx.chatAnnouncement, 'get', { path });
      if (after.revision_id !== meta.revision_id) throw Object.assign(new Error('Announcement changed during read'), { code: 'revision_changed' });
    } else throw Object.assign(new Error('Unknown announcement type'), { code: 'unknown_type' });
    text = text.trim();
    truncated ||= text.length > MAX_TEXT;
    return { status: text ? 'available' : 'empty', fetchedAt,
      revision: String(meta.revision_id ?? ''), updatedAt: String(meta.update_time_v2 || meta.update_time || ''),
      text: text.slice(0, MAX_TEXT), truncated };
  } catch (error) {
    return { status: Number(error.code) === 1770002 ? 'empty' : 'unavailable', fetchedAt,
      errorCode: String(error.code || error.response?.data?.code || 'read_failed') };
  }
}

export async function topicAnnouncementContext(runtime, summary, sessionId) {
  if (isFeishuDocumentCommentSummary(summary) || ['p2p', 'private'].includes(summary.chatType)
      || !summary.chatId || !(buildFeishuTopicId(summary) || summary.startThread
        || ['topic', 'thread'].includes(summary.conversationKind))) return null;
  const scope = [runtime.config?.sourceRouteId || 'default', summary.chatId, sessionId];
  const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const pathname = runtime.config?.storageDir ? join(runtime.config.storageDir, 'announcement-snapshots', `${key}.json`) : '';
  return serial(key, async () => {
    // This is the topic's source snapshot, never evidence that a Harness read it.
    let snapshot = pathname ? await readJson(pathname) : null;
    if (!snapshot || snapshot.version !== 1) {
      snapshot = { version: 1, ...await loadFeishuGroupAnnouncement(runtime, summary) };
      // Transient/permission failures are retried on a later input, not frozen forever.
      if (pathname && snapshot.status !== 'unavailable') {
        // A disk error must not drop the human's message or the fetched context.
        await writeJsonAtomic(pathname, snapshot, { mode: 0o600 }).catch(error =>
          console.warn(`[feishu-announcement] snapshot persistence failed: ${error.code || 'write_failed'}`));
      }
    }
    const text = snapshot.status === 'available' ? snapshot.text
      : snapshot.status === 'empty' ? '本话题首次读取时，群公告为空。'
        : `群公告读取失败（${snapshot.errorCode}）；不能视为无公告。需要公告时请补读。`;
    return { ...snapshot, text: undefined, messages: [{ messageId: `announcement:${key}`, messageRevision: snapshot.revision || snapshot.status,
      sender: '群公告', text, time: snapshot.fetchedAt }] };
  });
}
