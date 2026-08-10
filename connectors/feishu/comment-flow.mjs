import {
  isFeishuDocumentCommentSummary,
  normalizeReplyText,
  trimString,
  truncateLogPreview,
} from './index.mjs';

const MAX_COMMENT_REPLY_PAGES = 20;
const COMMENT_REPLY_PAGE_SIZE = 100;

function normalizeFileType(value) {
  return trimString(value).toLowerCase();
}

function buildCommentMessageId({ fileToken, commentId, replyId } = {}) {
  const parts = ['document-comment', fileToken, commentId, replyId || 'root'];
  return parts.map((part) => trimString(part).replace(/[^a-zA-Z0-9._:-]+/g, '_')).join(':');
}

export function summarizeFeishuDocumentCommentEvent(data = {}) {
  const noticeMeta = data?.notice_meta || {};
  const sender = noticeMeta?.from_user_id || data?.user_id || {};
  const target = noticeMeta?.to_user_id || {};
  const fileToken = trimString(data?.file_token || noticeMeta?.file_token);
  const fileType = normalizeFileType(data?.file_type || noticeMeta?.file_type);
  const commentId = trimString(data?.comment_id);
  const replyId = trimString(data?.reply_id);
  const noticeType = trimString(noticeMeta?.notice_type);
  const mentionedBot = data?.is_mentioned === true
    || noticeMeta?.is_mentioned === true
    || data?.is_mention === true;

  return {
    sourceKind: 'document_comment',
    eventId: trimString(data?.event_id || data?.uuid),
    eventType: trimString(data?.event_type) || 'drive.notice.comment_add_v1',
    tenantKey: trimString(data?.tenant_key),
    appId: trimString(data?.app_id),
    createTime: trimString(data?.create_time || noticeMeta?.timestamp || data?.ts),
    sender: {
      openId: trimString(sender?.open_id),
      userId: trimString(sender?.user_id),
      unionId: trimString(sender?.union_id),
      senderType: 'user',
      tenantKey: trimString(data?.tenant_key),
    },
    target: {
      openId: trimString(target?.open_id),
      userId: trimString(target?.user_id),
      unionId: trimString(target?.union_id),
    },
    chatId: '',
    chatType: 'document_comment',
    messageId: buildCommentMessageId({ fileToken, commentId, replyId }),
    messageType: 'comment',
    fileToken,
    fileType,
    commentId,
    replyId,
    noticeType,
    mentionedBot,
    mentions: [],
    messageText: '',
    textPreview: mentionedBot ? 'Document comment mentioning the bot' : 'Document comment',
    contentSummary: mentionedBot ? 'Document comment mentioning the bot' : 'Document comment',
    imageKeys: [],
    rawContent: '',
  };
}

function renderCommentElement(element, botUserIds) {
  const type = trimString(element?.type).toLowerCase();
  if (type === 'text_run') {
    return typeof element?.text_run?.text === 'string' ? element.text_run.text : '';
  }
  if (type === 'docs_link') {
    return trimString(element?.docs_link?.url);
  }
  if (type === 'person') {
    const userId = trimString(element?.person?.user_id);
    return botUserIds.has(userId) ? '@机器人' : '@成员';
  }
  return '';
}

export function renderFeishuCommentContent(content, { botUserIds = [] } = {}) {
  const botIds = new Set((Array.isArray(botUserIds) ? botUserIds : []).map(trimString).filter(Boolean));
  const elements = Array.isArray(content?.elements) ? content.elements : [];
  return elements
    .map((element) => renderCommentElement(element, botIds))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function normalizeCommentReply(reply, summary) {
  const imageCount = Array.isArray(reply?.extra?.image_list) ? reply.extra.image_list.length : 0;
  const text = renderFeishuCommentContent(reply?.content, {
    botUserIds: [
      summary?.target?.openId,
      summary?.target?.userId,
      summary?.target?.unionId,
    ],
  }) || (imageCount > 0 ? `[图片评论，共 ${imageCount} 张]` : '');
  return {
    replyId: trimString(reply?.reply_id),
    userId: trimString(reply?.user_id),
    createTime: Number(reply?.create_time) || 0,
    updateTime: Number(reply?.update_time) || 0,
    text,
    imageCount,
  };
}

function mergeCommentReplies(...groups) {
  const replies = [];
  const seen = new Set();
  for (const group of groups) {
    for (const reply of Array.isArray(group) ? group : []) {
      const replyId = trimString(reply?.reply_id);
      const key = replyId || JSON.stringify(reply?.content || {});
      if (!key || seen.has(key)) continue;
      seen.add(key);
      replies.push(reply);
    }
  }
  return replies;
}

async function listAllCommentReplies(runtime, summary) {
  const list = runtime?.appClient?.drive?.v1?.fileCommentReply?.list;
  if (typeof list !== 'function') return [];

  const replies = [];
  let pageToken = '';
  for (let page = 0; page < MAX_COMMENT_REPLY_PAGES; page += 1) {
    const response = await list({
      params: {
        file_type: summary.fileType,
        user_id_type: 'open_id',
        page_size: COMMENT_REPLY_PAGE_SIZE,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      path: {
        file_token: summary.fileToken,
        comment_id: summary.commentId,
      },
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(response.msg || `Failed to list Feishu document comment replies (${response.code})`);
    }
    replies.push(...(Array.isArray(response.data?.items) ? response.data.items : []));
    if (response.data?.has_more !== true) break;
    pageToken = trimString(response.data?.page_token);
    if (!pageToken) break;
  }
  return replies;
}

export async function hydrateFeishuDocumentCommentSummary(runtime, summary) {
  if (!isFeishuDocumentCommentSummary(summary)) return summary;
  if (!summary.fileToken || !summary.fileType || !summary.commentId) {
    throw new Error('Feishu document comment event is missing file_token, file_type, or comment_id');
  }
  const getComment = runtime?.appClient?.drive?.v1?.fileComment?.get;
  if (typeof getComment !== 'function') {
    throw new Error('Feishu document comment read API is unavailable');
  }

  const response = await getComment({
    params: {
      file_type: summary.fileType,
      user_id_type: 'open_id',
      need_reaction: false,
    },
    path: {
      file_token: summary.fileToken,
      comment_id: summary.commentId,
    },
  });
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(response.msg || `Failed to load Feishu document comment (${response.code})`);
  }

  const embeddedReplies = response.data?.reply_list?.replies;
  const listedReplies = await listAllCommentReplies(runtime, summary);
  const replies = mergeCommentReplies(embeddedReplies, listedReplies)
    .map((reply) => normalizeCommentReply(reply, summary));
  const currentReply = summary.replyId
    ? replies.find((reply) => reply.replyId === summary.replyId)
    : replies[0];
  if (!currentReply) {
    throw new Error(summary.replyId
      ? `Feishu document comment reply ${summary.replyId} was not found`
      : 'Feishu document comment has no readable content');
  }

  const currentIndex = replies.indexOf(currentReply);
  const commentThread = replies.map((reply, index) => ({
    text: reply.text || '[空评论]',
    isCurrent: index === currentIndex,
  }));
  const quote = trimString(response.data?.quote);
  return {
    ...summary,
    messageText: currentReply.text || '[空评论]',
    textPreview: truncateLogPreview(currentReply.text || '[空评论]'),
    contentSummary: `Document comment: ${truncateLogPreview(currentReply.text || '[empty comment]')}`,
    commentQuote: quote,
    commentThread,
    commentReplyCount: replies.length,
    currentCommentIndex: currentIndex,
  };
}

export async function sendFeishuCommentReply(runtime, summary, text) {
  if (!isFeishuDocumentCommentSummary(summary)) {
    throw new Error('Feishu document comment target is required');
  }
  const replyText = normalizeReplyText(text);
  if (!replyText) {
    throw new Error('Feishu document comment reply text is required');
  }
  const createReply = runtime?.appClient?.drive?.v1?.fileCommentReply?.create;
  if (typeof createReply !== 'function') {
    throw new Error('Feishu document comment reply API is unavailable');
  }

  const response = await createReply({
    params: {
      file_type: summary.fileType,
      user_id_type: 'open_id',
    },
    path: {
      file_token: summary.fileToken,
      comment_id: summary.commentId,
    },
    data: {
      content: {
        elements: [{
          type: 'text_run',
          text_run: { text: replyText },
        }],
      },
    },
  });
  const replyId = trimString(response.data?.reply_id);
  if ((response.code !== undefined && response.code !== 0) || !replyId) {
    throw new Error(response.msg || 'Failed to reply to Feishu document comment');
  }
  return {
    ...response.data,
    message_id: replyId,
    reply_id: replyId,
  };
}
