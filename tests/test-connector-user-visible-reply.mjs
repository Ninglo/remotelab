#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildConnectorFailureReply,
  classifyConnectorFailureReason,
  decideConnectorUserVisibleReply,
} from '../lib/connector-user-visible-reply.mjs';

const directReply = decideConnectorUserVisibleReply({
  replyText: '已处理。',
  duplicate: false,
  silentConfirmationText: '已收到。',
});
assert.deepEqual(directReply, {
  action: 'send_reply',
  text: '已处理。',
  status: 'sent',
  reason: '',
});

const duplicateSilent = decideConnectorUserVisibleReply({
  replyText: '',
  duplicate: true,
  silentConfirmationText: '已收到。',
});
assert.deepEqual(duplicateSilent, {
  action: 'silent',
  text: '',
  status: 'silent_no_reply',
  reason: 'duplicate_request',
});

const confirmationReply = decideConnectorUserVisibleReply({
  replyText: '',
  duplicate: false,
  silentConfirmationText: '已收到。',
});
assert.deepEqual(confirmationReply, {
  action: 'send_confirmation',
  text: '已收到。',
  status: 'confirmation_sent',
  reason: 'empty_assistant_reply',
});

const attachmentOnlyReply = decideConnectorUserVisibleReply({
  replyText: '',
  hasAttachments: true,
  duplicate: false,
  silentConfirmationText: '已收到。',
});
assert.deepEqual(attachmentOnlyReply, {
  action: 'send_reply',
  text: '',
  status: 'sent',
  reason: '',
});

assert.equal(
  classifyConnectorFailureReason('429 Organization concurrency limit exceeded (maximum 1)'),
  'provider_concurrency',
  'specific concurrency errors should outrank the generic 429 rate-limit category',
);
assert.equal(
  classifyConnectorFailureReason('engine_overloaded_error: service temporarily overloaded'),
  'provider_overload',
);
assert.equal(
  classifyConnectorFailureReason('Moonshot account has insufficient balance'),
  'provider_balance',
);
assert.equal(
  classifyConnectorFailureReason('401 invalid API key'),
  'provider_authentication',
);
assert.equal(
  classifyConnectorFailureReason('context_length_exceeded'),
  'request_context_limit',
);
assert.equal(
  classifyConnectorFailureReason('Provider requires interactive login before RemoteLab can use it'),
  'provider_authentication',
);
assert.equal(
  classifyConnectorFailureReason('Saved Codex resume thread is no longer available; RemoteLab cleared it. Please resend the message.'),
  'session_resume_unavailable',
);
assert.equal(
  classifyConnectorFailureReason('Failed to download file asset: fasset_example (400 Bad Request)'),
  'attachment_unavailable',
);
assert.equal(
  classifyConnectorFailureReason('an unrecognized provider failure'),
  'unknown',
);

assert.equal(
  buildConnectorFailureReply(
    { textPreview: '帮我看看这个问题' },
    '429 Organization concurrency limit exceeded (maximum 1)',
  ),
  '这次没有生成回复。原因：模型账户的并发额度已占满，目前仍没有可用容量，请稍后再试。',
  'Chinese failure replies should explain known concurrency failures',
);
assert.equal(
  buildConnectorFailureReply(
    { textPreview: 'Can you help me with this?' },
    'engine_overloaded_error: 服务临时过载',
  ),
  'I could not generate a reply because the model service is temporarily overloaded and has not recovered yet. Please try again later.',
  'reply language should follow the user message rather than the provider error language',
);
assert.equal(
  buildConnectorFailureReply(
    { textPreview: '请继续' },
    'Moonshot account has insufficient balance',
  ),
  '这次没有生成回复。原因：模型账户余额或可用信用不足，需要管理员补充余额或切换模型。',
  'terminal billing failures should explain the administrator action required',
);
assert.equal(
  buildConnectorFailureReply({ textPreview: '帮我看看这个问题' }, ''),
  '这次没有生成回复，但系统没有取得明确的失败原因。请稍后再试；如果持续出现，请联系管理员查看运行记录。',
  'generic Chinese fallback should be reserved for missing reasons',
);
assert.equal(
  buildConnectorFailureReply({ textPreview: 'Can you help me with this?' }, 'mystery failure'),
  'I could not generate a reply, but the system did not receive a specific failure reason. Please try again later; if this continues, contact an administrator to review the run logs.',
  'generic English fallback should be reserved for unclassified reasons',
);

console.log('test-connector-user-visible-reply: ok');
