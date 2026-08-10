#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildExternalTriggerId,
  buildMessageSourceContext,
  buildRemoteLabMessage,
  buildSessionSourceContext,
} from '../connectors/feishu/index.mjs';
import {
  hydrateFeishuDocumentCommentSummary,
  renderFeishuCommentContent,
  sendFeishuCommentReply,
  summarizeFeishuDocumentCommentEvent,
} from '../connectors/feishu/comment-flow.mjs';
import {
  addProcessingReaction,
  handleMessage,
  sendFeishuText,
} from '../scripts/feishu-connector.mjs';

const rawEvent = {
  event_id: 'evt_comment_1',
  event_type: 'drive.notice.comment_add_v1',
  tenant_key: 'tenant_comment_1',
  app_id: 'cli_comment_1',
  create_time: '1786010400000',
  notice_meta: {
    file_type: 'docx',
    file_token: 'docx_comment_1',
    from_user_id: {
      open_id: 'ou_comment_author_1',
      user_id: 'user_comment_author_1',
      union_id: 'on_comment_author_1',
    },
    to_user_id: {
      open_id: 'ou_comment_bot_1',
    },
    notice_type: 'add_reply',
  },
  comment_id: 'comment_1',
  reply_id: 'reply_current_1',
  is_mentioned: true,
};

const summary = summarizeFeishuDocumentCommentEvent(rawEvent);
assert.equal(summary.sourceKind, 'document_comment');
assert.equal(summary.messageId, 'document-comment:docx_comment_1:comment_1:reply_current_1');
assert.equal(summary.mentionedBot, true);
assert.equal(summary.sender.openId, 'ou_comment_author_1');
assert.equal(
  buildExternalTriggerId(summary),
  'feishu:document_comment:docx:docx_comment_1:comment_1',
  'all replies in one document-comment thread should reuse one RemoteLab session',
);
assert.deepEqual(buildSessionSourceContext(summary), {
  connector: 'feishu',
  conversationKind: 'document_comment',
  fileType: 'docx',
  fileToken: 'docx_comment_1',
  commentId: 'comment_1',
});
assert.deepEqual(buildMessageSourceContext(summary), {
  connector: 'feishu',
  conversationKind: 'document_comment',
  messageId: 'document-comment:docx_comment_1:comment_1:reply_current_1',
  fileType: 'docx',
  fileToken: 'docx_comment_1',
  commentId: 'comment_1',
  replyId: 'reply_current_1',
  contentSummary: 'Document comment mentioning the bot',
});

assert.equal(renderFeishuCommentContent({
  elements: [{
    type: 'person',
    person: { user_id: 'ou_comment_bot_1' },
  }, {
    type: 'text_run',
    text_run: { text: ' 请检查这一段' },
  }, {
    type: 'docs_link',
    docs_link: { url: 'https://example.com/context' },
  }],
}, { botUserIds: ['ou_comment_bot_1'] }), '@机器人 请检查这一段https://example.com/context');

const commentGetPayloads = [];
const commentListPayloads = [];
const commentCreatePayloads = [];
const runtime = {
  config: {
    silentConfirmationText: '',
    processingReaction: { enabled: true, removeOnCompletion: true },
  },
  processingMessageIds: new Set(),
  storagePaths: {
    handledMessagesPath: '/tmp/remotelab-feishu-comments-handled.json',
  },
  appClient: {
    drive: {
      v1: {
        fileComment: {
          get: async (payload) => {
            commentGetPayloads.push(payload);
            return {
              code: 0,
              data: {
                quote: '这段方案需要补充验证。',
                reply_list: {
                  replies: [{
                    reply_id: 'reply_root_1',
                    user_id: 'ou_comment_author_1',
                    create_time: 1786010000000,
                    content: {
                      elements: [{
                        type: 'text_run',
                        text_run: { text: '先看看这里的结论。' },
                      }],
                    },
                  }],
                },
              },
            };
          },
        },
        fileCommentReply: {
          list: async (payload) => {
            commentListPayloads.push(payload);
            return {
              code: 0,
              data: {
                has_more: false,
                items: [{
                  reply_id: 'reply_root_1',
                  user_id: 'ou_comment_author_1',
                  create_time: 1786010000000,
                  content: {
                    elements: [{
                      type: 'text_run',
                      text_run: { text: '先看看这里的结论。' },
                    }],
                  },
                }, {
                  reply_id: 'reply_current_1',
                  user_id: 'ou_comment_author_1',
                  create_time: 1786010400000,
                  content: {
                    elements: [{
                      type: 'person',
                      person: { user_id: 'ou_comment_bot_1' },
                    }, {
                      type: 'text_run',
                      text_run: { text: ' 能结合全文给一个修改建议吗？' },
                    }],
                  },
                }],
              },
            };
          },
          create: async (payload) => {
            commentCreatePayloads.push(payload);
            return {
              code: 0,
              data: {
                reply_id: 'reply_bot_1',
                user_id: 'ou_comment_bot_1',
              },
            };
          },
        },
      },
    },
  },
};

const hydrated = await hydrateFeishuDocumentCommentSummary(runtime, summary);
assert.equal(hydrated.messageText, '@机器人 能结合全文给一个修改建议吗？');
assert.equal(hydrated.commentQuote, '这段方案需要补充验证。');
assert.equal(hydrated.commentThread.length, 2);
assert.equal(hydrated.commentThread[1].isCurrent, true);
assert.match(buildRemoteLabMessage(hydrated), /文档中被评论的内容/);
assert.match(buildRemoteLabMessage(hydrated), /文档评论线程/);
assert.match(buildRemoteLabMessage(hydrated), /当前 @ 你的评论/);
assert.doesNotMatch(buildRemoteLabMessage(hydrated), /ou_comment_author_1|ou_comment_bot_1/);
assert.deepEqual(commentGetPayloads[0], {
  params: {
    file_type: 'docx',
    user_id_type: 'open_id',
    need_reaction: false,
  },
  path: {
    file_token: 'docx_comment_1',
    comment_id: 'comment_1',
  },
});
assert.equal(commentListPayloads[0].params.page_size, 100);

const directReply = await sendFeishuCommentReply(runtime, hydrated, '建议把验证条件写具体。');
assert.equal(directReply.message_id, 'reply_bot_1');
assert.deepEqual(commentCreatePayloads[0], {
  params: {
    file_type: 'docx',
    user_id_type: 'open_id',
  },
  path: {
    file_token: 'docx_comment_1',
    comment_id: 'comment_1',
  },
  data: {
    content: {
      elements: [{
        type: 'text_run',
        text_run: { text: '建议把验证条件写具体。' },
      }],
    },
  },
});

assert.equal(
  await addProcessingReaction(runtime, hydrated),
  null,
  'document comments should not call the chat-message reaction API',
);

const handled = [];
let generatedPrompt = '';
await handleMessage(runtime, summary, 'drive.notice.comment_add_v1', {
  wasMessageHandled: async () => false,
  hydrateSummary: hydrateFeishuDocumentCommentSummary,
  generateRemoteLabReply: async (_runtime, fullSummary) => {
    generatedPrompt = buildRemoteLabMessage(fullSummary);
    return {
      sessionId: 'session_comment_1',
      runId: 'run_comment_1',
      requestId: 'feishu:document-comment:docx_comment_1:comment_1:reply_current_1',
      responseId: 'response_comment_1',
      duplicate: false,
      replyText: '建议补充预期结果和失败回滚条件。',
      replyAttachments: [],
    };
  },
  sendFeishuText,
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.match(generatedPrompt, /能结合全文给一个修改建议吗/);
assert.equal(commentCreatePayloads.length, 2, 'the generated answer should be posted to the same comment thread');
assert.equal(
  commentCreatePayloads[1].data.content.elements[0].text_run.text,
  '建议补充预期结果和失败回滚条件。',
);
assert.equal(handled.length, 1);
assert.equal(handled[0].messageId, summary.messageId);
assert.equal(handled[0].metadata.status, 'sent');
assert.equal(handled[0].metadata.responseMessageId, 'reply_bot_1');
assert.equal(runtime.processingMessageIds.size, 0);

const unmentioned = summarizeFeishuDocumentCommentEvent({
  ...rawEvent,
  event_id: 'evt_comment_2',
  reply_id: 'reply_unmentioned_1',
  is_mentioned: false,
});
let unmentionedGenerated = false;
await handleMessage(runtime, unmentioned, 'drive.notice.comment_add_v1', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => {
    unmentionedGenerated = true;
    return {};
  },
});
assert.equal(unmentionedGenerated, false, 'document comments without a bot mention should stay silent');

console.log('ok - Feishu document comment mentions hydrate, reuse a thread session, and reply in place');
