import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../../lib/config.mjs';
import { describeSessionProgressPolicy, FEISHU_PROGRESS_MODES, progressPolicyForRun, usesOctober7GroupMessaging } from '../../lib/session-progress-policy.mjs';
import { recordFeishuCardAction } from './card-engagement.mjs';
import { usageKey } from '../../chat/usage-events.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';

// Match an actual durable card receipt, not just the Session id in a button.
export async function findProgressPolicyCard({ sessionId, messageId, sourceRouteId }, stateDir) {
  const files = await readdir(stateDir).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const file of files.filter(name => name.endsWith('.json'))) {
    const state = JSON.parse(await readFile(join(stateDir, file), 'utf8'));
    if (state.sourceRouteId !== sourceRouteId) continue;
    const stored = state.sessions?.[sessionId] || state.groupSessions?.[sessionId]
      || (state.sessionId === sessionId ? state : null);
    if (stored?.cards?.some(card => card.messageId === messageId)) return stored;
  }
  return null;
}

export async function handleFeishuProgressPolicyAction(runtime, raw, {
  request, authorize = async () => false, stateDir = join(CONFIG_DIR, 'workboards'), recordAction = recordFeishuCardAction,
} = {}) {
  const event = raw?.event || raw;
  let value = event?.action?.value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!['session-progress', 'progress-card'].includes(value?.namespace)) return null;
  const disclosure = value.namespace === 'progress-card';
  const reply = (content, type = 'error') => ({ toast: { type, content } });
  const chatId = trim(event.context?.open_chat_id || event.context?.chat_id);
  const messageId = trim(event.context?.open_message_id || event.context?.message_id);
  const actor = trim(event.operator?.operator_id?.open_id || event.operator?.open_id);
  if (!chatId || !messageId || !actor || !trim(value.sessionId) || !FEISHU_PROGRESS_MODES.has(value.mode)
      || !Number.isInteger(value.revision) || value.revision < 0
      || (disclosure && (!['expanded', 'collapsed'].includes(value.mode)
        || !Number.isSafeInteger(value.anchorSeq) || value.anchorSeq < 1))) return reply('无效的进展设置，请查看最新卡片。');
  const startedAt = Date.now();
  try {
    const route = runtime.config?.sourceRouteId || 'default';
    const card = await findProgressPolicyCard({ sessionId: value.sessionId, messageId, sourceRouteId: route }, stateDir);
    if (!card || card.chatId !== chatId || (disclosure && !card.cards.some(
      receipt => receipt.messageId === messageId && receipt.anchorSeq === value.anchorSeq))) return reply('这张卡片不属于当前会话，请查看原话题的最新卡片。');
    const current = await request(`/api/sessions/${encodeURIComponent(value.sessionId)}?view=summary`);
    if (!current.response?.ok) return reply('无法读取会话，输入 /progress 可重试。');
    const session = current.json?.session;
    const target = session?.conversation?.target;
    const summary = { chatId, chatType: target?.chatType, tenantKey: trim(event.tenant_key || raw?.header?.tenant_key),
      ...(target?.conversationKind === 'thread' ? { threadId: target.threadId } : {}),
      sender: { senderType: 'user', openId: actor,
        userId: trim(event.operator?.operator_id?.user_id || event.operator?.user_id),
        unionId: trim(event.operator?.operator_id?.union_id || event.operator?.union_id) } };
    if (session?.conversation?.connector !== 'feishu' || session.conversation.sourceRouteId !== route
        || target?.chatId !== chatId || (target.tenantKey && target.tenantKey !== summary.tenantKey)
        || !await authorize(summary)) return reply('无权操作这个会话的进展设置。');
    if (disclosure && usesOctober7GroupMessaging(session))
      return reply('群消息已恢复 10 月 7 日规则，请在原卡片选择“卡片＋新消息”或“只更新卡片”。');
    const changeId = trim(raw?.header?.event_id || event.event_id)
      || (trim(event.token) ? `token:${event.token}` : `button:${actor}:${messageId}:${value.revision}:${value.mode}`);
    const result = await request(`/api/sessions/${encodeURIComponent(value.sessionId)}/${disclosure ? 'progress-card' : 'progress-policy'}`, {
      method: 'POST', body: { mode: value.mode, expectedRevision: value.revision,
        ...(disclosure ? { anchorSeq: value.anchorSeq, actorOpenId: actor } : {}),
        ...(value.runId ? { runId: value.runId } : {}),
        changeId: changeId.startsWith('token:') ? `button-token:${usageKey(changeId)}` : changeId },
    });
    // Observation is separate from the shared card state and never changes a
    // Person's default. It must not delay or fail the button response.
    void Promise.resolve().then(() => recordAction({ route, actor, messageId, sessionId: value.sessionId,
      value, changeId, accepted: result.response?.ok === true })).catch(() => {});
    if (!result.response?.ok) return reply(result.json?.error || '切换未成功，输入 /progress 可重试。');
    if (usesOctober7GroupMessaging(session) && !disclosure)
      return reply(`${describeSessionProgressPolicy(result.json?.session)}；仅当前会话生效。`, 'success');
    if (disclosure) return reply(value.mode === 'expanded' ? '已显示进展；本卡片后续更新保留这一选择。'
      : '已折叠进展；本卡片后续更新保留这一选择。', 'success');
    return reply(`${describeSessionProgressPolicy(progressPolicyForRun(result.json?.session, value.runId))}；本轮生效；普通进展仍在卡片内更新。`, 'success');
  } catch (error) {
    console.warn(`[feishu-progress-policy] ${error.message}`);
    return reply('切换未获确认，请输入 /progress 查看当前设置后重试。');
  } finally {
    if (disclosure) console.log(`[feishu-progress-policy] disclosure session=${value.sessionId} anchor=${value.anchorSeq} saveMs=${Date.now() - startedAt}`);
  }
}
