function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function containsCjk(text) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(String(text || ''));
}

const CONNECTOR_FAILURE_PATTERNS = Object.freeze([
  ['provider_balance', [
    /insufficient[_ -]?balance/i,
    /balance[^\n]*(?:insufficient|too low|exhausted|depleted)/i,
    /payment required/i,
    /\b402\b/,
    /余额不足/u,
    /账户欠费/u,
  ]],
  ['provider_quota', [
    /insufficient[_ -]?quota/i,
    /quota[^\n]*(?:exceed|exhaust|deplet|used up|reached)/i,
    /(?:exceed|exhaust|deplet)[^\n]*quota/i,
    /credits?[^\n]*(?:exhaust|deplet|insufficient|used up)/i,
    /(?:额度|配额)[^\n]*(?:不足|耗尽|用完|超出)/u,
  ]],
  ['provider_safety', [
    /content[_ -]?policy/i,
    /safety policy/i,
    /moderation/i,
    /(?:content|request)[^\n]*blocked/i,
    /blocked[^\n]*(?:content|request)/i,
    /内容审核/u,
    /安全策略/u,
    /违规内容/u,
  ]],
  ['provider_authentication', [
    /unauthori[sz]ed/i,
    /authentication[^\n]*(?:failed|required|invalid)/i,
    /auth[_ -]?error/i,
    /interactive login/i,
    /provider[^\n]*(?:log ?in|login)[^\n]*(?:required|before)/i,
    /(?:log ?in|login)[^\n]*(?:provider|oauth|api[_ -]?key)/i,
    /invalid[^\n]*(?:api[_ -]?key|token|credential)/i,
    /(?:api[_ -]?key|token|credential)[^\n]*(?:invalid|missing|expired|revoked)/i,
    /permission denied/i,
    /\b40[13]\b/,
    /(?:授权|认证|密钥)[^\n]*(?:失效|无效|缺失|错误)/u,
  ]],
  ['provider_concurrency', [
    /concurren(?:cy|t)/i,
    /too many simultaneous/i,
    /maximum[^\n]*active (?:request|run)/i,
    /capacity limit/i,
    /并发[^\n]*(?:上限|限制|已满|超出)/u,
  ]],
  ['provider_overload', [
    /engine[_ -]?overloaded/i,
    /overload(?:ed)?/i,
    /(?:server|service|engine)[^\n]*(?:too busy|temporarily busy)/i,
    /(?:model|engine)[^\n]*at capacity/i,
    /at capacity[^\n]*(?:different model|try again)/i,
    /(?:服务|引擎|模型)[^\n]*(?:过载|繁忙|容量已满)/u,
  ]],
  ['provider_rate_limit', [
    /rate[_ -]?limit/i,
    /too many requests/i,
    /\b429\b/,
    /(?:请求过于频繁|限流)/u,
  ]],
  ['request_context_limit', [
    /context[_ -]?length/i,
    /context window/i,
    /maximum[^\n]*context/i,
    /(?:prompt|input)[^\n]*too long/i,
    /token[^\n]*limit/i,
    /request too large/i,
    /\b413\b/,
    /(?:上下文|输入|消息)[^\n]*(?:过长|超出)/u,
  ]],
  ['attachment_unavailable', [
    /(?:failed|unable) to (?:download|load|read)[^\n]*(?:file asset|attachment|uploaded file)/i,
    /file asset[^\n]*(?:not found|bad request|expired|unavailable)/i,
    /(?:附件|上传文件)[^\n]*(?:下载失败|读取失败|已过期|不可用)/u,
  ]],
  ['session_resume_unavailable', [
    /saved[^\n]*(?:resume|thread|session)[^\n]*no longer available/i,
    /(?:resume|conversation) thread[^\n]*(?:not found|unavailable)/i,
    /(?:thread|session)[^\n]*cleared[^\n]*resend/i,
    /stale rollout path/i,
    /thread\/resume[^\n]*(?:not found|unavailable|failed|error)/i,
    /(?:历史会话|恢复会话|上下文)[^\n]*(?:不可用|已失效)[^\n]*(?:重发|重新发送)/u,
  ]],
  ['provider_model_unavailable', [
    /model[_ -]?not[_ -]?found/i,
    /(?:unknown|invalid|unsupported) model/i,
    /model[^\n]*(?:does not exist|is not available|not supported)/i,
    /模型[^\n]*(?:不存在|不可用|不支持)/u,
  ]],
  ['run_cancelled', [
    /cancelled/i,
    /canceled/i,
    /aborted by (?:the )?user/i,
    /(?:任务|运行|请求)[^\n]*取消/u,
  ]],
  ['provider_timeout', [
    /timed? out/i,
    /timeout/i,
    /etimedout/i,
    /deadline exceeded/i,
    /(?:请求|服务|运行)[^\n]*超时/u,
  ]],
  ['provider_network', [
    /fetch failed/i,
    /econn(?:reset|refused|aborted)/i,
    /enotfound/i,
    /socket hang up/i,
    /network (?:error|unreachable)/i,
    /dns[^\n]*(?:failed|error)/i,
    /(?:网络|连接)[^\n]*(?:失败|中断|不可用)/u,
  ]],
  ['provider_unavailable', [
    /service unavailable/i,
    /temporarily unavailable/i,
    /bad gateway/i,
    /gateway timeout/i,
    /internal server error/i,
    /upstream[^\n]*(?:error|unavailable)/i,
    /\b50[0234]\b/,
    /(?:上游|模型服务)[^\n]*(?:不可用|异常)/u,
  ]],
  ['runtime_output_failure', [
    /exited with code/i,
    /provider exited before completing/i,
    /detached runner disappeared/i,
    /without emitting[^\n]*structured/i,
    /(?:zero|no)[^\n]*structured (?:output|event)/i,
    /no valid (?:response|output)/i,
    /empty (?:response|output)/i,
    /process[^\n]*(?:crash|terminated|exited)/i,
    /模型运行异常/u,
  ]],
]);

const CONNECTOR_FAILURE_MESSAGES = Object.freeze({
  provider_balance: {
    zh: '这次没有生成回复。原因：模型账户余额或可用信用不足，需要管理员补充余额或切换模型。',
    en: 'I could not generate a reply because the model account has insufficient balance or credit. An administrator needs to add credit or switch models.',
  },
  provider_quota: {
    zh: '这次没有生成回复。原因：模型账户的调用额度已经用尽，需要管理员补充额度或切换模型。',
    en: 'I could not generate a reply because the model account quota has been exhausted. An administrator needs to add quota or switch models.',
  },
  provider_safety: {
    zh: '这次没有生成回复。原因：请求被模型服务的内容安全策略拦截。请调整相关内容后再试。',
    en: 'I could not generate a reply because the request was blocked by the model service’s safety policy. Please revise the relevant content and try again.',
  },
  provider_authentication: {
    zh: '这次没有生成回复。原因：模型服务的授权已失效或配置不正确，需要管理员重新连接账号。',
    en: 'I could not generate a reply because the model service authorization is invalid or misconfigured. An administrator needs to reconnect the account.',
  },
  provider_concurrency: {
    zh: '这次没有生成回复。原因：模型账户的并发额度已占满，目前仍没有可用容量，请稍后再试。',
    en: 'I could not generate a reply because the model account’s concurrency capacity is full and no capacity is currently available. Please try again later.',
  },
  provider_overload: {
    zh: '这次没有生成回复。原因：模型服务当前临时过载，暂时还没有恢复，请稍后再试。',
    en: 'I could not generate a reply because the model service is temporarily overloaded and has not recovered yet. Please try again later.',
  },
  provider_rate_limit: {
    zh: '这次没有生成回复。原因：模型服务当前请求过于频繁，限流暂时还没有解除，请稍后再试。',
    en: 'I could not generate a reply because the model service is rate-limiting requests and the limit is still in place. Please try again later.',
  },
  request_context_limit: {
    zh: '这次没有生成回复。原因：消息、附件或会话上下文超过了模型的处理长度上限。请缩短内容、拆分附件，或开启新会话后再试。',
    en: 'I could not generate a reply because the message, attachments, or conversation exceeded the model’s context limit. Please shorten the content, split the attachments, or start a new session.',
  },
  attachment_unavailable: {
    zh: '这次没有生成回复。原因：系统无法读取消息中的附件，文件可能已失效或不可用。请重新上传附件后再试。',
    en: 'I could not generate a reply because an attachment could not be read and may have expired or become unavailable. Please upload the attachment again and retry.',
  },
  session_resume_unavailable: {
    zh: '这次没有生成回复。原因：模型保存的历史会话已失效，系统已经清除旧的恢复状态。请重新发送这条消息。',
    en: 'I could not generate a reply because the model’s saved conversation is no longer available. The stale resume state has been cleared; please send the message again.',
  },
  provider_model_unavailable: {
    zh: '这次没有生成回复。原因：当前选择的模型不存在、不可用或不受支持。请切换模型后再试。',
    en: 'I could not generate a reply because the selected model does not exist, is unavailable, or is unsupported. Please switch models and try again.',
  },
  run_cancelled: {
    zh: '这次没有生成回复。原因：本次处理任务已被取消。',
    en: 'I did not generate a reply because this processing run was cancelled.',
  },
  provider_timeout: {
    zh: '这次没有生成回复。原因：模型服务响应超时，未能在限定时间内完成，请稍后再试。',
    en: 'I could not generate a reply because the model service timed out and did not finish within the allowed time. Please try again later.',
  },
  provider_network: {
    zh: '这次没有生成回复。原因：系统暂时无法连接模型服务。请稍后再试。',
    en: 'I could not generate a reply because the system could not connect to the model service. Please try again later.',
  },
  provider_unavailable: {
    zh: '这次没有生成回复。原因：模型服务当前不可用，暂时还没有恢复，请稍后再试。',
    en: 'I could not generate a reply because the model service is currently unavailable and has not recovered yet. Please try again later.',
  },
  runtime_output_failure: {
    zh: '这次没有生成回复。原因：模型运行异常结束，没有产生可用的回复内容。请稍后再试。',
    en: 'I could not generate a reply because the model run ended unexpectedly without producing usable output. Please try again later.',
  },
  unknown: {
    zh: '这次没有生成回复，但系统没有取得明确的失败原因。请稍后再试；如果持续出现，请联系管理员查看运行记录。',
    en: 'I could not generate a reply, but the system did not receive a specific failure reason. Please try again later; if this continues, contact an administrator to review the run logs.',
  },
});

export function classifyConnectorFailureReason(reason = '') {
  const normalizedReason = trimString(reason);
  if (!normalizedReason) return 'unknown';
  for (const [category, patterns] of CONNECTOR_FAILURE_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(normalizedReason))) {
      return category;
    }
  }
  return 'unknown';
}

export function decideConnectorUserVisibleReply({
  replyText = '',
  hasAttachments = false,
  duplicate = false,
  silentConfirmationText = '',
} = {}) {
  const normalizedReplyText = trimString(replyText);
  if (normalizedReplyText || hasAttachments === true) {
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
    `${summary?.textPreview || ''}\n${summary?.contentSummary || ''}\n${summary?.rawContent || ''}`,
  );
  const category = classifyConnectorFailureReason(reason);
  const messages = CONNECTOR_FAILURE_MESSAGES[category] || CONNECTOR_FAILURE_MESSAGES.unknown;
  return prefersChinese ? messages.zh : messages.en;
}
