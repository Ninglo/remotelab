const USAGE = '用法：/log 关键词或问题\n例如：/log Auto Research 数据接入\n会返回最相关的 3 个历史 Session，以及会话链接和已上传的 LangSmith 链接；尚未上传时显示原因。';

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
      session.sessionUrl ? `[Session](${session.sessionUrl})` : '会话链接暂不可用',
      session.langsmithUrl
        ? `[LangSmith${session.langsmithKind === 'historical_import' ? '（历史日志导入）' : ''}](${session.langsmithUrl})`
        : `LangSmith：${LANGSMITH_STATUS[session.langsmithStatus] || LANGSMITH_STATUS.unavailable}`);
  }
  if (result.json?.incomplete) lines.push('', '部分历史记录暂时未能读取，以上结果可能不完整。');
  return lines.join('\n');
}
