#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = await mkdtemp(join(tmpdir(), 'remotelab-wechat-connector-home-'));
process.env.HOME = tempHome;

const {
  DEFAULT_SESSION_SYSTEM_PROMPT,
  createRuntimeContext,
  generateRemoteLabReply,
  handleWeChatMessage,
  loadAccountsDocument,
  loadConfig,
  loadContextTokensDocument,
  loadSyncStateDocument,
  persistLinkedAccount,
  pollAccountOnce,
  replayUnhandledMessages,
  resolveRedirectBaseUrl,
  runPollLoop,
  sendWeChatText,
  startWeChatLogin,
  waitForWeChatLogin,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'wechat-connector.mjs')).href);

const tempConfigDir = await mkdtemp(join(tmpdir(), 'remotelab-wechat-config-'));
const tempConfigPath = join(tempConfigDir, 'config.json');

let createPayload = null;
let submitPayload = null;
let sentIlinkPayload = null;
let sentIlinkHeaders = null;
let statusPollCalls = 0;
let getUpdatesCalls = 0;
let forceQueuedSubmit = false;
let forcePlanningSubmit = false;
let redirectReplyToOtherSession = false;
let forceDuplicateSubmitWithRunId = false;

function decodeResponseId(url, prefix) {
  return decodeURIComponent(String(url || '').slice(prefix.length));
}

const server = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  await new Promise((resolve) => req.on('end', resolve));

  if (req.method === 'GET' && req.url?.startsWith('/ilink/bot/get_bot_qrcode')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      qrcode: 'qr_test_1',
      qrcode_img_content: 'https://weixin.qq.com/x/qr_test_1',
    }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/ilink/bot/get_qrcode_status')) {
    statusPollCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (statusPollCalls === 1) {
      res.end(JSON.stringify({
        status: 'scaned_but_redirect',
        redirect_host: `127.0.0.1:${server.address().port}`,
      }));
      return;
    }
    res.end(JSON.stringify({
      status: 'confirmed',
      bot_token: 'bot_token_test_1',
      ilink_bot_id: 'bot_account_1',
      baseurl: `http://127.0.0.1:${server.address().port}/bot-api`,
      ilink_user_id: 'wx_user_owner_1',
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/bot-api/ilink/bot/getupdates') {
    getUpdatesCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ret: 0,
      msgs: [{
        message_id: 7448678501208393000,
        from_user_id: 'wx_user_peer_1',
        to_user_id: 'wx_user_owner_1',
        create_time_ms: 1710000000000,
        message_type: 1,
        message_state: 2,
        item_list: [{
          type: 1,
          text_item: { text: '你好，帮我看下实例状态。' },
        }],
        context_token: 'ctx_peer_1',
      }],
      get_updates_buf: 'buf_after_1',
      longpolling_timeout_ms: 47000,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/bot-api/ilink/bot/sendmessage') {
    sentIlinkHeaders = req.headers;
    sentIlinkPayload = JSON.parse(body || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions') {
    createPayload = JSON.parse(body || '{}');
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: {
        id: 'sess_wechat_1',
        latestSeq: 0,
        activity: {
          run: { state: 'idle' },
          queue: { count: 0 },
          compact: { state: 'idle' },
        },
      },
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_wechat_1/messages') {
    submitPayload = JSON.parse(body || '{}');
    res.writeHead(202, { 'Content-Type': 'application/json' });
    if (forceDuplicateSubmitWithRunId) {
      res.end(JSON.stringify({ duplicate: true, run: { id: 'run_wechat_1' } }));
      return;
    }
    if (forceQueuedSubmit) {
      res.end(JSON.stringify({ queued: true }));
      return;
    }
    if (forcePlanningSubmit) {
      res.end(JSON.stringify({
        response: {
          id: submitPayload?.requestId || 'wechat:bot_account_1:msg_reply_scope',
          state: 'checking',
        },
      }));
      return;
    }
    res.end(JSON.stringify({ run: { id: 'run_wechat_1' } }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/runs/run_wechat_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_wechat_1', state: 'completed' } }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/api/sessions/sess_wechat_1/responses/')) {
    const prefix = '/api/sessions/sess_wechat_1/responses/';
    const responseId = decodeResponseId(req.url, prefix);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      replyPublication: {
        id: responseId,
        responseIds: [responseId],
        state: 'ready',
        ready: true,
        rootRunId: 'run_wechat_1',
        finalRunId: 'run_wechat_1',
        continuationRunIds: [],
        payload: {
          text: redirectReplyToOtherSession ? '' : '<private>hidden</private> 已处理。',
        },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_wechat_1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (redirectReplyToOtherSession) {
      res.end(JSON.stringify({
        events: [
          {
            seq: 1,
            type: 'message',
            role: 'user',
            runId: 'run_wechat_1',
            requestId: 'wechat:bot_account_1:msg_reply_scope',
            content: 'Please confirm the WeChat app scope.',
          },
          {
            seq: 2,
            type: 'message',
            role: 'assistant',
            messageKind: 'session_continuation_notice',
            content: 'A new session was created as [Redirected](/?session=sess_wechat_redirect_1&tab=sessions).',
          },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({
      events: [{
        seq: 1,
        type: 'message',
        role: 'assistant',
        runId: 'run_wechat_1',
        requestId: 'wechat:bot_account_1:msg_reply_scope',
        content: '<private>hidden</private> 已处理。',
      }],
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_wechat_redirect_1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [{
        seq: 1,
        type: 'message',
        role: 'assistant',
        runId: 'run_wechat_1',
        requestId: 'wechat:bot_account_1:msg_reply_scope',
        content: '分流后的回复。',
      }],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const port = server.address().port;
  await writeFile(tempConfigPath, `${JSON.stringify({
    storageDir: tempConfigDir,
    chatBaseUrl: `http://127.0.0.1:${port}`,
    apiBaseUrl: `http://127.0.0.1:${port}/bot-api`,
    sessionFolder: repoRoot,
    login: {
      qrBaseUrl: `http://127.0.0.1:${port}`,
      waitTimeoutMs: 4000,
      statusPollIntervalMs: 10,
      statusTimeoutMs: 500,
    },
    polling: {
      timeoutMs: 500,
      idleDelayMs: 10,
      errorDelayMs: 10,
    },
  }, null, 2)}\n`, 'utf8');

  const loadedConfig = await loadConfig(tempConfigPath);
  assert.equal(loadedConfig.sessionTool, 'codex');
  assert.equal(loadedConfig.systemPrompt, '');
  assert.equal(loadedConfig.runtimeSelectionPath, join(tempConfigDir, 'ui-runtime-selection.json'));
  assert.match(DEFAULT_SESSION_SYSTEM_PROMPT, /Keep connector-specific overrides minimal/i);

  const nestedStorageConfigPath = join(tempConfigDir, 'nested-config.json');
  await writeFile(nestedStorageConfigPath, `${JSON.stringify({
    storageDir: join(tempConfigDir, 'wechat-connector'),
  }, null, 2)}\n`, 'utf8');
  const nestedStorageConfig = await loadConfig(nestedStorageConfigPath);
  assert.equal(
    nestedStorageConfig.runtimeSelectionPath,
    join(tempConfigDir, 'ui-runtime-selection.json'),
    'wechat-connector storage dirs should default to the parent config root runtime selection file',
  );

  await writeFile(tempConfigPath, `${JSON.stringify({
    storageDir: tempConfigDir,
    systemPrompt: '',
  }, null, 2)}\n`, 'utf8');
  const explicitEmptyPromptConfig = await loadConfig(tempConfigPath);
  assert.equal(explicitEmptyPromptConfig.systemPrompt, '');

  const missingConfig = await loadConfig(join(tempConfigDir, 'missing-config.json'));
  assert.equal(missingConfig.sourceName, 'WeChat');
  assert.equal(missingConfig.group, 'WeChat');

  assert.equal(
    resolveRedirectBaseUrl('127.0.0.1:9999', 'http://127.0.0.1:8888'),
    'http://127.0.0.1:9999',
    'redirect host should preserve the current scheme',
  );

  await writeFile(tempConfigPath, `${JSON.stringify({
    storageDir: tempConfigDir,
    chatBaseUrl: `http://127.0.0.1:${port}`,
    apiBaseUrl: `http://127.0.0.1:${port}/bot-api`,
    sessionFolder: repoRoot,
    login: {
      qrBaseUrl: `http://127.0.0.1:${port}`,
      waitTimeoutMs: 4000,
      statusPollIntervalMs: 10,
      statusTimeoutMs: 500,
    },
    polling: {
      timeoutMs: 500,
      idleDelayMs: 10,
      errorDelayMs: 10,
    },
  }, null, 2)}\n`, 'utf8');
  const config = await loadConfig(tempConfigPath);
  await writeFile(config.runtimeSelectionPath, `${JSON.stringify({
    selectedTool: 'codex',
    selectedModel: 'ui-model-test',
    selectedEffort: 'medium',
    thinkingEnabled: false,
    reasoningKind: 'enum',
  }, null, 2)}\n`, 'utf8');

  const loginSession = await startWeChatLogin(config);
  assert.equal(loginSession.qrcodeUrl, 'https://weixin.qq.com/x/qr_test_1');

  const loginResult = await waitForWeChatLogin(config, loginSession, {
    displayQr: async () => true,
    timeoutMs: 4000,
    statusPollIntervalMs: 10,
    statusTimeoutMs: 500,
  });
  assert.equal(loginResult.connected, true);
  assert.equal(loginResult.accountId, 'bot_account_1');
  assert.equal(loginResult.botToken, 'bot_token_test_1');
  assert.equal(loginResult.baseUrl, `http://127.0.0.1:${port}/bot-api`);
  assert.equal(loginResult.userId, 'wx_user_owner_1');

  await persistLinkedAccount(config, loginResult);
  const accountsDoc = await loadAccountsDocument(config.storagePaths.accountsPath);
  assert.equal(accountsDoc.defaultAccountId, 'bot_account_1');
  assert.equal(accountsDoc.accounts.bot_account_1.token, 'bot_token_test_1');
  assert.equal(accountsDoc.accounts.bot_account_1.userId, 'wx_user_owner_1');

  const runtime = createRuntimeContext(config, {
    accountsDoc,
    syncStateDoc: await loadSyncStateDocument(config.storagePaths.syncStatePath),
    contextTokensDoc: await loadContextTokensDocument(config.storagePaths.contextTokensPath),
  });

  const handledSummaries = [];
  await pollAccountOnce(runtime, 'bot_account_1', {
    handleWeChatMessage: async (_runtime, summary) => {
      handledSummaries.push(summary);
    },
  });
  await Promise.all([...runtime.chatQueues.values()]);

  const syncDoc = await loadSyncStateDocument(config.storagePaths.syncStatePath);
  assert.equal(syncDoc.accounts.bot_account_1.getUpdatesBuf, 'buf_after_1');
  assert.equal(syncDoc.accounts.bot_account_1.longPollTimeoutMs, 47000);

  const contextDoc = await loadContextTokensDocument(config.storagePaths.contextTokensPath);
  assert.equal(contextDoc.accounts.bot_account_1.wx_user_peer_1.token, 'ctx_peer_1');
  assert.equal(handledSummaries.length, 1);
  assert.equal(handledSummaries[0].messageId, '7448678501208393000');
  assert.equal(handledSummaries[0].textPreview, '你好，帮我看下实例状态。');

  const replyRuntime = createRuntimeContext({
    ...config,
    chatBaseUrl: `http://127.0.0.1:${port}`,
  }, {
    accountsDoc,
    syncStateDoc: syncDoc,
    contextTokensDoc: contextDoc,
  });
  replyRuntime.authCookie = 'session_token=test-cookie';

  const reply = await generateRemoteLabReply(replyRuntime, {
    accountId: 'bot_account_1',
    accountUserId: 'wx_user_owner_1',
    peerUserId: 'wx_user_peer_1',
    messageId: 'msg_reply_scope',
    messageTypeNumeric: 1,
    messageType: 'user',
    messageStateNumeric: 2,
    messageState: 'finish',
    textPreview: 'Please confirm the WeChat app scope.',
    contentSummary: 'Please confirm the WeChat app scope.',
  });

  assert.equal(createPayload?.sourceId, 'wechat');
  assert.equal(createPayload?.sourceName, 'WeChat');
  assert.equal(createPayload?.group, 'WeChat');
  assert.equal(createPayload?.systemPrompt, '');
  assert.equal(createPayload?.externalTriggerId, 'wechat:bot_account_1:wx_user_peer_1');

  assert.equal(submitPayload?.requestId, 'wechat:bot_account_1:msg_reply_scope');
  assert.equal(submitPayload?.tool, 'codex');
  assert.equal(submitPayload?.model, 'ui-model-test');
  assert.equal(submitPayload?.effort, 'medium');
  assert.equal(submitPayload?.text, 'Please confirm the WeChat app scope.');

  assert.equal(reply.sessionId, 'sess_wechat_1');
  assert.equal(reply.runId, 'run_wechat_1');
  assert.equal(reply.requestId, 'wechat:bot_account_1:msg_reply_scope');
  assert.equal(reply.replyText, '已处理。');

  forcePlanningSubmit = true;
  const planningReply = await generateRemoteLabReply(replyRuntime, {
    accountId: 'bot_account_1',
    accountUserId: 'wx_user_owner_1',
    peerUserId: 'wx_user_peer_1',
    messageId: 'msg_reply_scope',
    messageTypeNumeric: 1,
    messageType: 'user',
    messageStateNumeric: 2,
    messageState: 'finish',
    textPreview: 'Please confirm the WeChat app scope.',
    contentSummary: 'Please confirm the WeChat app scope.',
  });
  forcePlanningSubmit = false;

  assert.equal(
    planningReply.replyText,
    '已处理。',
    'wechat connector should accept planning replies that return a response id before a run id exists',
  );
  assert.equal(planningReply.runId, 'run_wechat_1');

  redirectReplyToOtherSession = true;
  const redirectedReply = await generateRemoteLabReply(replyRuntime, {
    accountId: 'bot_account_1',
    accountUserId: 'wx_user_owner_1',
    peerUserId: 'wx_user_peer_1',
    messageId: 'msg_reply_scope',
    messageTypeNumeric: 1,
    messageType: 'user',
    messageStateNumeric: 2,
    messageState: 'finish',
    textPreview: 'Please confirm the WeChat app scope.',
    contentSummary: 'Please confirm the WeChat app scope.',
  });
  redirectReplyToOtherSession = false;

  assert.equal(
    redirectedReply.replyText,
    '分流后的回复。',
    'wechat connector should follow session dispatch notices to the redirected session reply',
  );

  forceDuplicateSubmitWithRunId = true;
  const duplicateReply = await generateRemoteLabReply(replyRuntime, {
    accountId: 'bot_account_1',
    accountUserId: 'wx_user_owner_1',
    peerUserId: 'wx_user_peer_1',
    messageId: 'msg_reply_scope',
    messageTypeNumeric: 1,
    messageType: 'user',
    messageStateNumeric: 2,
    messageState: 'finish',
    textPreview: 'Please confirm the WeChat app scope.',
    contentSummary: 'Please confirm the WeChat app scope.',
  });
  forceDuplicateSubmitWithRunId = false;

  assert.equal(
    duplicateReply.replyText,
    '已处理。',
    'duplicate submits with an existing run should reuse the stored assistant reply',
  );

  forceQueuedSubmit = true;
  await assert.rejects(
    generateRemoteLabReply(replyRuntime, {
      accountId: 'bot_account_1',
      accountUserId: 'wx_user_owner_1',
      peerUserId: 'wx_user_peer_1',
      messageId: 'msg_queued_scope',
      messageTypeNumeric: 1,
      messageType: 'user',
      messageStateNumeric: 2,
      messageState: 'finish',
      textPreview: 'This should not get queued.',
      contentSummary: 'This should not get queued.',
    }),
    /expected an immediate run/i,
    'wechat connector should fail fast instead of trying to recover queued busy-session submits',
  );
  forceQueuedSubmit = false;

  const sendRuntime = createRuntimeContext(config, {
    accountsDoc,
    syncStateDoc: syncDoc,
    contextTokensDoc: contextDoc,
  });
  const sendResult = await sendWeChatText(sendRuntime, {
    accountId: 'bot_account_1',
    peerUserId: 'wx_user_peer_1',
    contextToken: '',
  }, 'Outbound reply text.');

  assert.match(sendResult.message_id, /^remotelab-wechat-/);
  assert.equal(sentIlinkPayload?.msg?.to_user_id, 'wx_user_peer_1');
  assert.equal(sentIlinkPayload?.msg?.context_token, 'ctx_peer_1');
  assert.equal(sentIlinkPayload?.msg?.item_list?.[0]?.text_item?.text, 'Outbound reply text.');
  assert.equal(sentIlinkHeaders?.authorizationtype, 'ilink_bot_token');
  assert.equal(sentIlinkHeaders?.authorization, 'Bearer bot_token_test_1');
  assert.ok(sentIlinkHeaders?.['x-wechat-uin'], 'sendMessage should include X-WECHAT-UIN');

  let unsupportedHandled = null;
  await handleWeChatMessage({
    config,
    storagePaths: {
      ...config.storagePaths,
      handledMessagesPath: join(tempConfigDir, 'handled-unsupported.json'),
    },
    accountsDoc,
    contextTokensDoc: contextDoc,
    processingMessageIds: new Set(),
  }, {
    accountId: 'bot_account_1',
    peerUserId: 'wx_user_peer_1',
    messageId: 'msg_voice_1',
    messageTypeNumeric: 1,
    messageType: 'user',
    messageStateNumeric: 2,
    messageState: 'finish',
    textPreview: '',
    contentSummary: '[voice message]',
  }, {
    wasMessageHandled: async () => false,
    markMessageHandled: async (_pathname, _messageKey, metadata) => {
      unsupportedHandled = metadata;
    },
  });
  assert.equal(unsupportedHandled?.status, 'silent_no_reply');
  assert.equal(unsupportedHandled?.reason, 'unsupported_message_type');

  const ackMessages = [];
  let ackHandled = null;
  await handleWeChatMessage({
    config: {
      ...config,
      processingAckDelayMs: 10,
      processingAckText: '已收到，正在处理。',
    },
    storagePaths: {
      ...config.storagePaths,
      handledMessagesPath: join(tempConfigDir, 'handled-processing-ack.json'),
    },
    accountsDoc,
    contextTokensDoc: contextDoc,
    processingMessageIds: new Set(),
  }, {
    accountId: 'bot_account_1',
    peerUserId: 'wx_user_peer_1',
    messageId: 'msg_ack_1',
    messageTypeNumeric: 1,
    messageType: 'user',
    messageStateNumeric: 2,
    messageState: 'finish',
    textPreview: '请慢慢处理这个问题。',
    contentSummary: '请慢慢处理这个问题。',
  }, {
    wasMessageHandled: async () => false,
    markMessageHandled: async (_pathname, _messageKey, metadata) => {
      ackHandled = metadata;
    },
    generateRemoteLabReply: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        sessionId: 'sess_wechat_1',
        runId: 'run_wechat_1',
        requestId: 'wechat:bot_account_1:msg_ack_1',
        duplicate: false,
        queued: false,
        replyText: '最终回复。',
        timingMs: {
          total: 30,
          session: 5,
          submit: 5,
          run: 20,
          replyLoad: 0,
        },
      };
    },
    sendWeChatText: async (_runtime, _summary, text) => {
      ackMessages.push(text);
      return {
        message_id: `reply_${ackMessages.length}`,
      };
    },
  });
  assert.deepEqual(ackMessages, ['已收到，正在处理。', '最终回复。']);
  assert.equal(ackHandled?.processingAckMessageId, 'reply_1');
  assert.equal(ackHandled?.responseMessageId, 'reply_2');

  const replayEventsPath = join(tempConfigDir, 'replay-events.jsonl');
  const replayHandledPath = join(tempConfigDir, 'replay-handled.json');
  await writeFile(replayEventsPath, [
    JSON.stringify({
      sourceLabel: 'getupdates',
      receivedAt: '2026-04-11T14:11:13.532Z',
      summary: {
        accountId: 'bot_account_1',
        accountUserId: 'wx_user_owner_1',
        peerUserId: 'wx_user_peer_1',
        messageId: 'msg_replay_pending',
        seq: 11,
        createTimeMs: 1710000000000,
        messageType: 'user',
        messageTypeNumeric: 1,
        messageState: 'finish',
        messageStateNumeric: 2,
        textPreview: '重启后请补发这条消息。',
        contentSummary: '重启后请补发这条消息。',
        itemTypes: ['text'],
      },
    }),
    '',
  ].join('\n'), 'utf8');

  const replayRuntime = {
    config,
    storagePaths: {
      ...config.storagePaths,
      eventsLogPath: replayEventsPath,
      handledMessagesPath: replayHandledPath,
    },
    accountsDoc,
    contextTokensDoc: contextDoc,
    processingMessageIds: new Set(),
  };
  const replayedMessages = [];
  const replayCount = await replayUnhandledMessages(replayRuntime, {
    handleWeChatMessageImpl: async (_runtime, summary) => {
      replayedMessages.push(summary.messageId);
    },
  });
  assert.equal(replayCount, 1);
  assert.deepEqual(replayedMessages, ['msg_replay_pending']);

  createPayload = null;
  submitPayload = null;
  sentIlinkPayload = null;
  sentIlinkHeaders = null;
  getUpdatesCalls = 0;

  await writeFile(tempConfigPath, `${JSON.stringify({
    storageDir: tempConfigDir,
    chatBaseUrl: `http://127.0.0.1:${port}`,
    apiBaseUrl: `http://127.0.0.1:${port}/bot-api`,
    sessionFolder: repoRoot,
    login: {
      qrBaseUrl: `http://127.0.0.1:${port}`,
      waitTimeoutMs: 4000,
      statusPollIntervalMs: 10,
      statusTimeoutMs: 500,
    },
    polling: {
      timeoutMs: 100,
      idleDelayMs: 10,
      errorDelayMs: 10,
    },
  }, null, 2)}\n`, 'utf8');
  const idleConfig = await loadConfig(tempConfigPath);
  const idleRuntime = createRuntimeContext(idleConfig, {
    accountsDoc: { defaultAccountId: '', accounts: {} },
    syncStateDoc: { accounts: {} },
    contextTokensDoc: { accounts: {} },
  });
  idleRuntime.authCookie = 'session_token=test-cookie';

  const idleLoop = runPollLoop(idleRuntime, { durationMs: 140 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await persistLinkedAccount(idleConfig, {
    connected: true,
    accountId: 'bot_account_1',
    botToken: 'bot_token_test_1',
    baseUrl: `http://127.0.0.1:${port}/bot-api`,
    userId: 'wx_user_owner_1',
  });
  await idleLoop;
  await Promise.all([...idleRuntime.chatQueues.values()]);

  assert.ok(getUpdatesCalls >= 1, 'idle poller should pick up linked accounts written after startup');
  assert.equal(idleRuntime.accountsDoc.defaultAccountId, 'bot_account_1');
  assert.equal(createPayload?.sourceId, 'wechat');
  assert.equal(submitPayload?.requestId, 'wechat:bot_account_1:7448678501208393000');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempConfigDir, { recursive: true, force: true });
  await rm(tempHome, { recursive: true, force: true });
}

console.log('ok - wechat connector config defaults load correctly');
console.log('ok - wechat qr login persists linked account state');
console.log('ok - wechat polling persists sync cursor and context token');
console.log('ok - generated WeChat sessions use the wechat app scope');
console.log('ok - outbound WeChat replies reuse stored context tokens');
console.log('ok - non-text WeChat payloads are ignored in the first text-only pass');
console.log('ok - slow WeChat turns send a processing acknowledgement before the final reply');
console.log('ok - idle WeChat workers pick up newly linked accounts without restart');
