import { findCommandSession } from './runtime-commands.mjs';

const DEFAULT_LOG_QUESTION = '请帮我查看当前会话在这条 /log 消息之前的运行记录，并说明如何查看对应的 LangSmith 日志。';

/** Resolve the diagnostic target before admitting the /log turn. */
export async function prepareFeishuLogContinuation(value, { request, runtime, summary }) {
  if (!runtime || !summary) return { error: '当前话题信息暂不可用，请稍后重试 /log。' };
  const question = String(value ?? '');
  try {
    const session = await findCommandSession(runtime, summary, request);
    if (!session?.id) return { error: '当前话题还没有关联 Session，请先在这里发起一次正常对话。' };
    const result = await request(`/api/sessions/${encodeURIComponent(session.id)}/latest-run`);
    if (!result.response?.ok || result.json?.sessionId !== session.id) {
      return { error: '当前 Session 的运行记录暂不可用，请稍后重试 /log。' };
    }
    return {
      sessionId: session.id,
      runId: result.json.runId || '',
      question: question.trim() ? question : DEFAULT_LOG_QUESTION,
    };
  } catch {
    return { error: '当前 Session 查询暂时不可用，请稍后重试 /log。' };
  }
}
