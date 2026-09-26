import { findCommandSession } from './runtime-commands.mjs';

const CURRENT_SESSION_QUERY = /(?:当前|这个|本次|这次)(?:这个|的)?\s*(?:session\b|会话|话题|线程|日志|trace\b)|^(?:当前|这个|本次|这次|current|here)$/iu;

export function isCurrentSessionLogQuery(value) {
  const query = String(value || '').trim().normalize('NFKC');
  if (!query) return true;
  if (/^(?:搜索|查找|历史)\s+/u.test(query)) return false;
  return CURRENT_SESSION_QUERY.test(query);
}

const LANGSMITH_STATUS = {
  disabled: '未启用上传',
  missing: '尚未纳入上传',
  pending: '等待上传',
  waiting: '等待会话结束或服务恢复后上传',
  failed: '上传失败',
  unsupported_timestamp: '历史日期超出上传窗口，尚未导入',
  unsupported: '该会话类型尚不支持上传',
  empty: '没有可上传的运行记录',
  unavailable: '上传状态暂不可用',
};

function safeTitle(value) {
  return String(value || '未命名会话').replace(/[\r\n]+/g, ' ').slice(0, 160)
    .replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&');
}

export async function handleFeishuLogCommand(value, { request, runtime, summary }) {
  const query = String(value || '').trim();
  if (query.length > 1000) return '检索内容过长，请把 /log 后的关键词或问题缩短到 1000 字以内。';
  if (isCurrentSessionLogQuery(query)) {
    if (!runtime || !summary) return '当前话题信息暂不可用，请稍后重试 /log。';
    try {
      const session = await findCommandSession(runtime, summary, request);
      if (!session?.id) return '当前话题还没有关联 Session。检索历史会话可用 /log 关键词。';
      const result = await request(`/api/sessions/${encodeURIComponent(session.id)}/langsmith?format=json`);
      if (!result.response?.ok) return '当前 Session 的 LangSmith 状态暂不可用，请稍后重试 /log。';
      const smith = result.json || {};
      const lines = [`当前 Session：${safeTitle(session.name)}`];
      if (smith.langsmithUrl) {
        lines.push(`[LangSmith](${smith.langsmithEntryUrl || smith.langsmithUrl})`);
      } else {
        lines.push(`LangSmith：${LANGSMITH_STATUS[smith.status] || LANGSMITH_STATUS.unavailable}`);
      }
      if (smith.sessionUrl) lines.push(`[Session](${smith.sessionUrl})`);
      return lines.join('\n');
    } catch {
      return '当前 Session 查询暂时不可用，请稍后重试 /log。';
    }
  }
  let result;
  try {
    const searchQuery = query.replace(/^(?:搜索|查找|历史)\s+/u, '');
    result = await request(`/api/sessions/search?q=${encodeURIComponent(searchQuery)}`);
  } catch {
    return '历史会话检索暂时未完成，请稍后重试 /log。';
  }
  if (!result.response?.ok) return '历史会话检索暂时不可用，请稍后重试 /log。';
  const sessions = Array.isArray(result.json?.sessions) ? result.json.sessions.slice(0, 3) : [];
  const lines = [sessions.length ? `找到 ${sessions.length} 个相关历史 Session（按相关度排序）：` : '没有找到相关历史 Session，请换一组更具体的关键词。'];
  for (const [index, session] of sessions.entries()) {
    lines.push('', `${index + 1}. ${safeTitle(session.title)}`,
      session.sessionUrl ? `[Session](${session.sessionUrl})` : '会话链接暂不可用',
      session.langsmithUrl
        ? `[LangSmith${session.langsmithKind === 'historical_import' ? '（历史日志导入）' : ''}](${session.langsmithEntryUrl || session.langsmithUrl})`
        : `LangSmith：${LANGSMITH_STATUS[session.langsmithStatus] || LANGSMITH_STATUS.unavailable}`);
  }
  if (result.json?.incomplete) lines.push('', '部分历史记录暂时未能读取，以上结果可能不完整。');
  return lines.join('\n');
}
