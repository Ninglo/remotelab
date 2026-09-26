const USAGE = '用法：/log 关键词或问题\n例如：/log Auto Research 数据接入\n会返回最相关的 3 个历史 Session，以及会话和 LangSmith 链接。';

function safeTitle(value) {
  return String(value || '未命名会话').replace(/[\r\n]+/g, ' ').slice(0, 160)
    .replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&');
}

export async function handleFeishuLogCommand(value, { request }) {
  const query = String(value || '').trim();
  if (!query) return USAGE;
  if (query.length > 1000) return '检索内容过长，请把 /log 后的关键词或问题缩短到 1000 字以内。';
  let result;
  try {
    result = await request(`/api/sessions/search?q=${encodeURIComponent(query)}`);
  } catch {
    return '历史会话检索暂时未完成，请稍后重试 /log。';
  }
  if (!result.response?.ok) return '历史会话检索暂时不可用，请稍后重试 /log。';
  const sessions = Array.isArray(result.json?.sessions) ? result.json.sessions.slice(0, 3) : [];
  const lines = [sessions.length ? `找到 ${sessions.length} 个相关历史 Session（按相关度排序）：` : '没有找到相关历史 Session，请换一组更具体的关键词。'];
  for (const [index, session] of sessions.entries()) {
    lines.push('', `${index + 1}. ${safeTitle(session.title)}`,
      session.sessionUrl ? `[查看会话](${session.sessionUrl})` : '会话链接暂不可用',
      session.langsmithUrl ? `[LangSmith](${session.langsmithUrl})`
        : session.langsmithStatus === 'unavailable' ? 'LangSmith：暂不可用' : 'LangSmith：暂无记录');
  }
  if (result.json?.incomplete) lines.push('', '部分历史记录暂时未能读取，以上结果可能不完整。');
  return lines.join('\n');
}
