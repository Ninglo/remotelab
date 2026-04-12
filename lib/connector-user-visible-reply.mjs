function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function containsCjk(text) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(String(text || ''));
}

export function decideConnectorUserVisibleReply({
  replyText = '',
  duplicate = false,
  silentConfirmationText = '',
} = {}) {
  const normalizedReplyText = trimString(replyText);
  if (normalizedReplyText) {
    return {
      action: 'send_reply',
      text: normalizedReplyText,
      status: 'sent',
      reason: '',
    };
  }

  if (duplicate === true) {
    return {
      action: 'silent',
      text: '',
      status: 'silent_no_reply',
      reason: 'duplicate_request',
    };
  }

  const normalizedConfirmationText = trimString(silentConfirmationText);
  if (normalizedConfirmationText) {
    return {
      action: 'send_confirmation',
      text: normalizedConfirmationText,
      status: 'confirmation_sent',
      reason: 'empty_assistant_reply',
    };
  }

  return {
    action: 'silent',
    text: '',
    status: 'silent_no_reply',
    reason: 'empty_assistant_reply',
  };
}

export function buildConnectorFailureReply(summary = {}, reason = '') {
  const prefersChinese = containsCjk(
    `${summary?.textPreview || ''}\n${summary?.contentSummary || ''}\n${summary?.rawContent || ''}\n${reason}`,
  );
  if (prefersChinese) {
    return '我收到了你的消息，但这次生成回复失败了。你可以稍后再发一次。';
  }
  return 'I received your message, but I could not generate a reply just now. Please try again in a moment.';
}
