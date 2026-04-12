#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildConnectorFailureReply,
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

assert.equal(
  buildConnectorFailureReply({ textPreview: '帮我看看这个问题' }, ''),
  '我收到了你的消息，但这次生成回复失败了。你可以稍后再发一次。',
  'Chinese failure replies should stay connector-agnostic and consistent',
);
assert.equal(
  buildConnectorFailureReply({ textPreview: 'Can you help me with this?' }, ''),
  'I received your message, but I could not generate a reply just now. Please try again in a moment.',
  'English failure replies should stay connector-agnostic and consistent',
);

console.log('test-connector-user-visible-reply: ok');
