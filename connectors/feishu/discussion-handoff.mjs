import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRecordStore } from '../../lib/durable-records.mjs';
import { FEISHU_CONTEXT_MAX_AGE_MS, loadFeishuConversationContext } from './conversation-context.mjs';
import { buildFeishuTopicId } from './index.mjs';
import { feishuJevApiKey } from './quick-participation.mjs';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-1.13.0';
const VERIFY_TIMEOUT_MS = 1_800;
// Quick nomination already requires 0.90. The source check must still choose
// offer, but its probability can vary slightly on identical evidence.
const VERIFY_OFFER_THRESHOLD = 0.80;
const HISTORY_MESSAGES = 100;
const HISTORY_CHARACTERS = 48_000;

const trim = value => typeof value === 'string' ? value.trim() : '';
const keyFor = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function discussionHandoffLink(runtime, summary) {
  return runtime?.config?.projectLinks?.find(link => link.handoffCards === true
    && link.discussionChatId === summary?.chatId) || null;
}

export function proposalKey(summary) {
  return keyFor(`${trim(summary?.chatId)}:${trim(summary?.messageId)}`);
}

export function formatDiscussionEvidence(messages, sourceSummary) {
  const safe = value => trim(value).replace(/[<>&]/g, character => ({ '<': '＜', '>': '＞', '&': '＆' })[character]);
  const lines = (Array.isArray(messages) ? messages : [])
    .filter(message => trim(message?.text))
    .map(message => `[${trim(message.time)}] ${safe(message.sender) || '群成员'}：${safe(message.text)}`
      + (trim(message.messageId) ? ` （消息 ${trim(message.messageId)}）` : ''));
  if (!lines.some(line => line.includes(`消息 ${sourceSummary.messageId}）`))) {
    lines.push(`[当前消息] ${safe(sourceSummary.senderName) || '群成员'}：${safe(sourceSummary.messageText)}`
      + ` （消息 ${sourceSummary.messageId}）`);
  }
  return lines.join('\n');
}

export function buildDiscussionHandoffCard(proposal) {
  const excerpt = trim(proposal.source.messageText).slice(0, 240) || '讨论群提出了待执行事项。';
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '是否移交干活群施工？' } },
    body: { elements: [
      { tag: 'div', text: { tag: 'plain_text', content: excerpt } },
      { tag: 'markdown', content: '确认后会新建干活群话题，并把本次讨论和原消息交给独立会话。' },
      { tag: 'column_set', columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [
          { tag: 'button', type: 'primary_filled', text: { tag: 'plain_text', content: '移交干活群' },
            behaviors: [{ type: 'callback', value: { action: 'confirm', proposalId: proposal.key } }] },
        ] },
        { tag: 'column', width: 'weighted', weight: 1, elements: [
          { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '继续讨论' },
            behaviors: [{ type: 'callback', value: { action: 'dismiss', proposalId: proposal.key } }] },
        ] },
      ] },
    ] },
  };
}

export function buildDiscussionHandoffResultCard(proposal) {
  const dismissed = proposal.status === 'dismissed';
  return {
    schema: '2.0', config: { update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text',
      content: dismissed ? '已选择继续讨论' : '已移交干活群' } },
    body: { elements: [
      { tag: 'div', text: { tag: 'plain_text', content: dismissed
        ? '本次没有创建干活话题。'
        : '干活话题已创建，后续工作请在新话题继续。' } },
      ...(!dismissed ? [{ tag: 'markdown', content: `[打开干活话题](${workLink(proposal)})` }] : []),
    ] },
  };
}

export function parseDiscussionHandoffAction(raw) {
  const event = raw?.event && typeof raw.event === 'object' ? raw.event : raw;
  const value = event?.action?.value;
  const action = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!action || !['confirm', 'dismiss'].includes(action.action)
    || !/^[a-f0-9]{24}$/.test(trim(action.proposalId))) return null;
  return {
    action: action.action,
    proposalId: action.proposalId,
    chatId: trim(event?.context?.open_chat_id || event?.context?.chat_id || event?.chat_id),
    cardMessageId: trim(event?.context?.open_message_id || event?.context?.message_id || event?.message_id),
    operatorId: trim(event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.operator_id),
  };
}

export async function verifyDiscussionHandoff(evidence, { fetchImpl = fetch, key, timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  const token = key || await feishuJevApiKey();
  if (!token) return { offer: false, reason: 'missing_key' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(process.env.TYPESAFE_BASE_URL || JEV_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: { discussion: evidence.slice(-16_000) },
        questions: { transfer: {
          type: 'choice',
          instructions: 'Read this project discussion, especially the newest human message. Offer an optional work-group handoff card only if the discussion has settled a specific executable direction and a human clearly wants work to start now. A question, idea, summary without a request, tentative agreement, or an already running task is not enough. The card asks for confirmation; this choice does not execute work.',
          criteria: {
            offer: 'A concrete decision and affirmative start-work intent are both present.',
            none: 'A definite new work handoff is not established.',
          },
        } },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { offer: false, reason: `http_${response.status}` };
    const result = await response.json();
    const answer = result?.answers?.transfer;
    const probability = Number(answer?.probabilities?.offer);
    const offer = answer?.choice === 'offer' && Number.isFinite(probability)
      && probability >= VERIFY_OFFER_THRESHOLD;
    return { offer,
      probability: Number.isFinite(probability) ? probability : null,
      reason: offer ? '' : answer?.choice === 'offer' ? 'below_threshold' : 'not_handoff' };
  } catch (error) {
    return { offer: false, reason: error?.name === 'AbortError' ? 'timeout' : 'request_error' };
  } finally {
    clearTimeout(timer);
  }
}

function sourceFromSummary(summary) {
  return {
    chatId: trim(summary.chatId), messageId: trim(summary.messageId),
    threadId: buildFeishuTopicId(summary), tenantKey: trim(summary.tenantKey || summary.sender?.tenantKey),
    messageText: trim(summary.messageText || summary.textPreview).slice(0, 2_000),
    senderName: trim(summary.sender?.name || summary.sender?.senderName),
    createTime: trim(summary.createTime),
  };
}

function sourceLink(source) {
  const chat = encodeURIComponent(source.chatId);
  return source.threadId
    ? `https://applink.feishu.cn/client/thread/open?open_chat_id=${chat}&open_thread_id=${encodeURIComponent(source.threadId)}`
    : `https://applink.feishu.cn/client/chat/open?openChatId=${chat}`;
}

function workLink(proposal) {
  return `https://applink.feishu.cn/client/thread/open?open_chat_id=${encodeURIComponent(proposal.workChatId)}`
    + `&open_thread_id=${encodeURIComponent(proposal.workThreadId || proposal.workMessageId)}`;
}

function checkedMessage(response, label) {
  if ((response?.code !== undefined && response.code !== 0) || !trim(response?.data?.message_id)) {
    throw new Error(response?.msg || `${label} did not return a message ID`);
  }
  return response.data;
}

async function sendProposalCard(runtime, proposal, card) {
  return checkedMessage(await runtime.appClient.im.v1.message.reply({
    path: { message_id: proposal.source.messageId },
    data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: true,
      uuid: `handoff-card-${proposal.key}-${proposal.cardGeneration || 0}` },
  }), 'Handoff card');
}

async function updateProposalCard(runtime, proposal, card) {
  const response = await runtime.appClient.im.v1.message.patch({
    path: { message_id: proposal.cardMessageId }, data: { content: JSON.stringify(card) },
  });
  if (response?.code !== undefined && response.code !== 0) {
    throw new Error(response.msg || 'Handoff card update failed');
  }
}

async function sendWorkTopic(runtime, proposal, found) {
  const source = proposal.source;
  const text = `从讨论群确认移交：${source.messageText.slice(0, 500)}\n\n来源：${sourceLink(source)}`
    + `\n已检索 ${found.count} 条讨论消息${found.truncated ? '（更早内容未完全覆盖）' : ''}。具体过程和结果请在此话题继续。`;
  return checkedMessage(await runtime.appClient.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: proposal.workChatId, msg_type: 'text', content: JSON.stringify({ text }),
      uuid: `project-handoff-work-${proposal.key}` },
  }), 'Work topic');
}

async function sendDiscussionNotice(runtime, proposal, status) {
  const text = status === 'dismissed'
    ? '已收到：这次继续在讨论群讨论，暂不移交干活群。'
    : status === 'failed'
      ? '移交暂未完成。请先核对两个群的成员可见范围及连接状态，之后可再次点击卡片重试。'
    : `已移交干活群，工作话题：${workLink(proposal)}`;
  return checkedMessage(await runtime.appClient.im.v1.message.reply({
    path: { message_id: proposal.source.messageId },
    data: { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: true,
      uuid: `handoff-${status}-${proposal.key}` },
  }), 'Discussion handoff notice');
}

async function listHumanMemberIds(runtime, chatId) {
  const members = new Set();
  let pageToken = '';
  do {
    const response = await runtime.appClient.im.v1.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}) },
    });
    if ((response?.code !== undefined && response.code !== 0) || !Array.isArray(response?.data?.items)) {
      throw new Error(response?.msg || 'Unable to verify current Feishu group membership');
    }
    for (const item of response.data.items) if (trim(item?.member_id)) members.add(item.member_id);
    pageToken = response.data.has_more === true ? trim(response.data.page_token) : '';
  } while (pageToken);
  return members;
}

export async function verifyDiscussionHandoffTarget(runtime, workChatId) {
  const response = await runtime.appClient.im.v1.chat.get({ path: { chat_id: workChatId } });
  if (response?.code !== undefined && response.code !== 0) {
    throw new Error(response?.msg || 'Unable to verify handoff work chat');
  }
  if (response?.data?.chat_mode !== 'topic' || response?.data?.chat_status !== 'normal') {
    throw new Error('Handoff work chat is not an active topic chat');
  }
  return true;
}

export async function verifyDiscussionHandoffVisibility(runtime, proposal) {
  const [, discussion, work] = await Promise.all([
    verifyDiscussionHandoffTarget(runtime, proposal.workChatId),
    listHumanMemberIds(runtime, proposal.source.chatId),
    listHumanMemberIds(runtime, proposal.workChatId),
  ]);
  if (!discussion.size || !work.size || [...work].some(member => !discussion.has(member))) {
    throw new Error('Work chat members are not all in the source discussion chat');
  }
  return true;
}

export function createDiscussionHandoffPilot(runtime, {
  store = createRecordStore(join(runtime.config.storageDir, 'project-handoffs')),
  readHistory = (summary) => loadFeishuConversationContext(runtime, summary, {
    maxMessages: HISTORY_MESSAGES, maxCharacters: HISTORY_CHARACTERS,
    // A decision may follow an earlier discussion after a long pause. The
    // ordinary reply context's four-hour activity gap must not cut it off.
    maxGapMs: FEISHU_CONTEXT_MAX_AGE_MS, includeMetadata: true,
  }),
  verify = verifyDiscussionHandoff,
  sendCard = (proposal, card) => sendProposalCard(runtime, proposal, card),
  updateCard = (proposal, card) => updateProposalCard(runtime, proposal, card),
  sendWorkRoot = (proposal, found) => sendWorkTopic(runtime, proposal, found),
  submitWork,
  notifySource = (proposal, status) => sendDiscussionNotice(runtime, proposal, status),
  verifyVisibility = proposal => verifyDiscussionHandoffVisibility(runtime, proposal),
  verifyTarget = link => verifyDiscussionHandoffTarget(runtime, link.workChatId),
} = {}) {
  const inFlight = new Map();
  const exclusive = (key, operation) => {
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = Promise.resolve().then(operation).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  };
  const contextSummary = (source, { atProposal = false } = {}) => ({
    chatId: source.chatId,
    messageId: '',
    ...(source.threadId ? { threadId: source.threadId } : {}),
    createTime: atProposal ? source.createTime : String(Date.now()),
  });
  const evidenceFor = async (source, options = {}) => {
    const context = await readHistory(contextSummary(source, options));
    return { evidence: formatDiscussionEvidence(context?.messages, source), truncated: context?.truncated === true,
      count: context?.messages?.length || 0 };
  };

  async function offerCandidate(summary) {
    const link = discussionHandoffLink(runtime, summary);
    if (!link || !trim(summary?.messageId)) return null;
    const key = proposalKey(summary);
    return exclusive(key, async () => {
      if (await store.get(key)) return null;
      const source = sourceFromSummary(summary);
      const existing = await store.active();
      if (existing.some(record => record.source?.chatId === source.chatId
        && !['dismissed'].includes(record.status)
        && (source.threadId
          ? record.source?.threadId === source.threadId
          : !record.source?.threadId && Date.now() - Date.parse(record.createdAt) < 15 * 60_000))) return null;
      await verifyTarget(link);
      const found = await evidenceFor(source, { atProposal: true });
      const verdict = await verify(found.evidence);
      if (!verdict.offer) {
        console.log(`[feishu-handoff] ${source.messageId} not offered: ${verdict.reason || 'verification_rejected'}`
          + ` probability=${verdict.probability ?? 'unknown'} evidence=${found.count}`);
        return null;
      }
      const proposal = await store.mutate(key, current => current || {
        status: 'offering', projectId: link.projectId, workChatId: link.workChatId,
        source, createdAt: new Date().toISOString(), evidenceCount: found.count,
        evidenceTruncated: found.truncated,
        verification: { probability: verdict.probability ?? null, reason: verdict.reason || '' },
      });
      if (proposal.status !== 'offering') return proposal;
      const receipt = await sendCard(proposal, buildDiscussionHandoffCard(proposal));
      return store.mutate(key, current => ({ ...current, status: 'offered',
        cardMessageId: trim(receipt?.message_id), offeredAt: new Date().toISOString() }));
    });
  }

  async function renewCard(key) {
    return exclusive(key, async () => {
      const current = await store.get(key);
      if (!current || !['offered', 'dismissed'].includes(current.status)
        || !runtime.config.projectLinks?.some(link => link.handoffCards === true
          && link.discussionChatId === current.source.chatId && link.workChatId === current.workChatId)) return null;
      await verifyTarget({ workChatId: current.workChatId });
      const renewing = await store.mutate(key, value => ({ ...value, status: 'offering',
        cardGeneration: (value.cardGeneration || 0) + 1,
        dismissedBy: undefined, dismissedAt: undefined, cardPatchedAt: undefined,
        sourceNoticeId: undefined, lastError: undefined }));
      const receipt = await sendCard(renewing, buildDiscussionHandoffCard(renewing));
      return store.mutate(key, value => ({ ...value, status: 'offered',
        cardMessageId: trim(receipt?.message_id), offeredAt: new Date().toISOString() }));
    });
  }

  async function patchResultCard(proposal) {
    if (proposal.cardPatchedAt || !proposal.cardMessageId) return proposal;
    await updateCard(proposal, buildDiscussionHandoffResultCard(proposal));
    return store.mutate(proposal.key, value => ({ ...value, cardPatchedAt: new Date().toISOString() }));
  }

  async function continueDismissed(proposal) {
    let current = proposal;
    if (!current.sourceNoticeId) {
      const notice = await notifySource(current, 'dismissed');
      current = await store.mutate(current.key, value => ({ ...value,
        sourceNoticeId: trim(notice?.message_id) }));
    }
    return patchResultCard(current);
  }

  async function continueAccepted(proposal) {
    let current = proposal;
    if (!trim(current.workMessageId)) {
      await verifyVisibility(current);
      const found = await evidenceFor(current.source);
      const root = await sendWorkRoot(current, found);
      current = await store.mutate(current.key, value => ({ ...value,
        workMessageId: trim(root?.message_id), workThreadId: trim(root?.thread_id || root?.message_id),
        evidenceCount: found.count, evidenceTruncated: found.truncated }));
      if (!current.workMessageId) throw new Error('Work topic did not return a message ID');
    }
    if (!trim(current.sessionId)) {
      const found = await evidenceFor(current.source);
      const receipt = await submitWork(current, found);
      current = await store.mutate(current.key, value => ({ ...value,
        sessionId: trim(receipt?.sessionId), runId: trim(receipt?.runId), status: 'submitted' }));
      if (!current.sessionId) throw new Error('Work Session did not return an ID');
    }
    if (!trim(current.sourceNoticeId)) {
      const notice = await notifySource(current, 'submitted');
      current = await store.mutate(current.key, value => ({ ...value,
        sourceNoticeId: trim(notice?.message_id), status: 'completed', completedAt: new Date().toISOString() }));
    }
    return patchResultCard(current);
  }

  async function actionFeedback(raw) {
    const action = parseDiscussionHandoffAction(raw);
    if (!action?.operatorId || !action.chatId || !action.cardMessageId) {
      return { accepted: false, toast: { type: 'error', content: '无法识别这次点击，请刷新后重试。' } };
    }
    const current = await store.get(action.proposalId);
    if (!current || current.source?.chatId !== action.chatId
      || current.cardMessageId !== action.cardMessageId
      || !runtime.config.projectLinks?.some(link => link.handoffCards === true
        && link.discussionChatId === current.source.chatId && link.workChatId === current.workChatId)) {
      return { accepted: false, toast: { type: 'warning', content: '这张卡片已失效，请使用原话题中的新卡片。' } };
    }
    if (current.status === 'dismissed') {
      return { accepted: false, toast: { type: 'info', content: '已选择继续讨论，本次没有移交。' } };
    }
    if (current.status === 'completed') {
      return { accepted: false, toast: { type: 'info', content: '这项工作已经移交，请打开卡片中的干活话题。' } };
    }
    if (current.status === 'offering' || (action.action === 'dismiss' && current.confirmedBy)) {
      return { accepted: false, toast: { type: 'warning', content: '这张卡片正在处理，请稍后查看结果。' } };
    }
    return { accepted: true, toast: { type: 'info', content: action.action === 'confirm'
      ? '已收到移交请求，完成后会在原话题留下干活链接。'
      : '已收到继续讨论的选择，不会创建干活话题。' } };
  }

  async function handleAction(raw) {
    const action = parseDiscussionHandoffAction(raw);
    if (!action?.operatorId || !action.chatId || !action.cardMessageId) return null;
    return exclusive(action.proposalId, async () => {
      let current = await store.get(action.proposalId);
      if (!current || current.source?.chatId !== action.chatId
        || (current.cardMessageId && current.cardMessageId !== action.cardMessageId)
        || !runtime.config.projectLinks?.some(link => link.handoffCards === true
          && link.discussionChatId === current.source.chatId && link.workChatId === current.workChatId)) return null;
      if (current.status === 'offering') return current;
      if (action.action === 'dismiss') {
        if (current.status !== 'offered') return current;
        current = await store.mutate(current.key, value => ({ ...value,
          status: 'dismissed', dismissedBy: action.operatorId, dismissedAt: new Date().toISOString() }));
        return continueDismissed(current);
      }
      if (current.status === 'dismissed') return current;
      if (!current.confirmedBy) current = await store.mutate(current.key, value => ({ ...value,
        status: 'accepted', confirmedBy: action.operatorId, confirmedAt: new Date().toISOString() }));
      try { return await continueAccepted(current); }
      catch (error) {
        const latest = await store.mutate(current.key, value => ({ ...value,
          lastError: String(error?.message || error).slice(0, 300) }));
        // The work may already be complete when only the card update fails.
        if (latest.status !== 'completed') await notifySource(latest, 'failed').catch(() => {});
        throw error;
      }
    });
  }

  async function restore() {
    const records = await store.active();
    for (const record of records) {
      if (record.status === 'offering' && discussionHandoffLink(runtime, { chatId: record.source?.chatId })) {
        await exclusive(record.key, async () => {
          const receipt = await sendCard(record, buildDiscussionHandoffCard(record));
          await store.mutate(record.key, value => ({ ...value, status: 'offered', cardMessageId: trim(receipt?.message_id) }));
        }).catch(error => console.warn(`[feishu-handoff] restore card ${record.key}: ${error.message}`));
      } else if (record.status === 'dismissed' && (!record.sourceNoticeId || !record.cardPatchedAt)) {
        await exclusive(record.key, () => continueDismissed(record))
          .catch(error => console.warn(`[feishu-handoff] restore dismissal ${record.key}: ${error.message}`));
      } else if (record.confirmedBy && (record.status !== 'completed' || !record.cardPatchedAt)) {
        await exclusive(record.key, () => continueAccepted(record))
          .catch(error => console.warn(`[feishu-handoff] restore work ${record.key}: ${error.message}`));
      }
    }
  }

  return { offerCandidate, renewCard, actionFeedback, handleAction, restore };
}
