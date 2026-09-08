#!/usr/bin/env node
import assert from 'assert/strict';
import { createCipheriv } from 'crypto';
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
  handleWeChatMessageAsync,
  initializeWeChatInbox,
  loadAccountsDocument,
  loadConfig,
  loadContextTokensDocument,
  loadSyncStateDocument,
  persistLinkedAccount,
  pollAccountOnce,
  replayUnhandledMessages,
  resolveDefaultWeChatTarget,
  resolveRedirectBaseUrl,
  runPollLoop,
  saveAccountsDocument,
  sendDirectWeChatTextToDefaultBinding,
  sendWeChatText,
  startWeChatLogin,
  submitWeChatMessageAsync,
  summarizeWeChatMessage,
  waitForWeChatLogin,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'wechat-connector.mjs')).href);
const {
  createWeChatInboundResourceService,
} = await import(pathToFileURL(join(repoRoot, 'connectors', 'wechat', 'inbound-resources.mjs')).href);

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
let forceDuplicateSubmitWithRunId = false;
let forcePublicationFailureReason = '';
let encryptedImage = Buffer.alloc(0);

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

  if (req.method === 'GET' && req.url === '/wechat-image.enc') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': encryptedImage.length,
    });
    res.end(encryptedImage);
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

  // /api/sessions/.../responses/ is NOT used: the async path has no publication wait.

  if (req.method === 'GET' && req.url === '/api/sessions/sess_wechat_1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
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

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const port = server.address().port;

  const imageKeyHex = '00112233445566778899aabbccddeeff';
  const imagePlaintext = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from('wechat image test'),
    Buffer.from([0xff, 0xd9]),
  ]);
  const imageCipher = createCipheriv('aes-128-ecb', Buffer.from(imageKeyHex, 'hex'), null);
  encryptedImage = Buffer.concat([imageCipher.update(imagePlaintext), imageCipher.final()]);
  let publishedImage = null;
  const imageService = createWeChatInboundResourceService({
    resolveHostname: async () => ['203.0.113.10'],
    fetch: async (url) => {
      assert.equal(url, 'https://wechat.example/image.enc');
      return new Response(encryptedImage, {
        status: 200,
        headers: { 'content-length': String(encryptedImage.length) },
      });
    },
  });
  const imageResolution = await imageService.resolve({
    publishRemoteLabAsset: async (asset) => {
      publishedImage = asset;
      return {
        id: 'asset_wechat_image_1',
        mimeType: asset.mimeType,
        originalName: asset.originalName,
        sizeBytes: asset.body.length,
      };
    },
  }, {
    messageId: 'msg_image_1',
    imageResources: [{
      downloadUrl: 'https://wechat.example/image.enc',
      aesKey: imageKeyHex,
    }],
  }, { sessionId: 'sess_wechat_image_1' });
  assert.deepEqual(publishedImage?.body, imagePlaintext);
  assert.equal(imageResolution.failures.length, 0);
  assert.equal(imageResolution.attachments[0]?.assetId, 'asset_wechat_image_1');
  assert.equal(imageResolution.attachments[0]?.mimeType, 'image/jpeg');

  let blockedFetchCalls = 0;
  const blockedImageService = createWeChatInboundResourceService({
    fetch: async () => {
      blockedFetchCalls += 1;
      return new Response(encryptedImage);
    },
  });
  await assert.rejects(
    blockedImageService.download({}, {
      sessionId: 'sess_blocked_image',
      messageId: 'msg_blocked_image',
      resource: { downloadUrl: 'https://127.0.0.1/image.enc', aesKey: imageKeyHex },
    }),
    /private network/,
  );
  assert.equal(blockedFetchCalls, 0, 'private image URLs must be rejected before fetching');

  const redirectImageService = createWeChatInboundResourceService({
    resolveHostname: async () => ['203.0.113.11'],
    fetch: async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/private.enc' },
    }),
  });
  await assert.rejects(
    redirectImageService.download({}, {
      sessionId: 'sess_redirect_image',
      messageId: 'msg_redirect_image',
      resource: { downloadUrl: 'https://wechat.example/redirect.enc', aesKey: imageKeyHex },
    }),
    /must use HTTPS/,
  );

  const oversizedImageService = createWeChatInboundResourceService({
    maxBytes: 16,
    resolveHostname: async () => ['203.0.113.12'],
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(12));
        controller.enqueue(new Uint8Array(12));
        controller.close();
      },
    })),
  });
  await assert.rejects(
    oversizedImageService.download({}, {
      sessionId: 'sess_oversized_image',
      messageId: 'msg_oversized_image',
      resource: { downloadUrl: 'https://wechat.example/oversized.enc', aesKey: imageKeyHex },
    }),
    /exceeds 16 bytes/,
  );

  const imageSummary = summarizeWeChatMessage({
    message_id: 'msg_image_summary_1',
    from_user_id: 'wx_user_peer_1',
    message_type: 1,
    message_state: 2,
    item_list: [{
      type: 2,
      image_item: {
        aeskey: imageKeyHex,
        media: {
          full_url: 'https://wechat.example/image.enc',
          aes_key: Buffer.from(imageKeyHex).toString('base64'),
        },
      },
    }],
  }, { accountId: 'bot_account_1' });
  assert.equal(imageSummary.contentSummary, '[image message]');
  assert.equal(imageSummary.imageResources.length, 1);
  assert.equal(imageSummary.imageResources[0]?.downloadUrl, 'https://wechat.example/image.enc');
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

  // --- Test: pollAccountOnce accepts inbound messages into the durable inbox ---
  const acceptedSummaries = [];
  const fakeInbox = {
    accept: async (id, entry) => { acceptedSummaries.push({ id, summary: entry.summary }); },
  };
  const runtimeWithInbox = createRuntimeContext(config, {
    accountsDoc,
    syncStateDoc: await loadSyncStateDocument(config.storagePaths.syncStatePath),
    contextTokensDoc: await loadContextTokensDocument(config.storagePaths.contextTokensPath),
  });
  runtimeWithInbox.inbox = fakeInbox;

  await pollAccountOnce(runtimeWithInbox, 'bot_account_1');

  const syncDoc = await loadSyncStateDocument(config.storagePaths.syncStatePath);
  assert.equal(syncDoc.accounts.bot_account_1.getUpdatesBuf, 'buf_after_1');
  assert.equal(syncDoc.accounts.bot_account_1.longPollTimeoutMs, 47000);

  const contextDoc = await loadContextTokensDocument(config.storagePaths.contextTokensPath);
  assert.equal(contextDoc.accounts.bot_account_1.wx_user_peer_1.token, 'ctx_peer_1');
  assert.equal(acceptedSummaries.length, 1);
  assert.equal(acceptedSummaries[0].summary.messageId, '7448678501208393000');
  assert.equal(acceptedSummaries[0].summary.textPreview, '\u4f60\u597d\uff0c\u5e2e\u6211\u770b\u4e0b\u5b9e\u4f8b\u72b6\u6001\u3002');
  // pollAccountOnce routes to inbox.accept; it must NOT call waitForConnectorPublication.
  // (Verified below via the fetch spy in the submitWeChatMessageAsync test.)

  // --- Test: submitWeChatMessageAsync creates session + submits; no publication wait ---
  const observedPaths = [];
  const replyRuntime = createRuntimeContext({
    ...config,
    chatBaseUrl: `http://127.0.0.1:${port}`,
    wechatInboundResourceAllowPrivateNetwork: true,
  }, {
    accountsDoc,
    syncStateDoc: syncDoc,
    contextTokensDoc: contextDoc,
  });
  replyRuntime.authCookie = 'session_token=test-cookie';

  // Wrap requestJson to spy on paths.
  let publicationPollAttempted = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...args) => {
    const urlStr = String(url);
    observedPaths.push(urlStr);
    if (urlStr.includes('/responses/')) publicationPollAttempted = true;
    return origFetch(url, ...args);
  };

  try {
    const receipt = await submitWeChatMessageAsync(replyRuntime, {
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
      imageResources: [],
    });

    assert.equal(createPayload?.sourceId, 'wechat');
    assert.equal(createPayload?.sourceName, 'WeChat');
    assert.equal(createPayload?.group, 'WeChat');
    assert.equal(createPayload?.externalTriggerId, 'wechat:bot_account_1:wx_user_peer_1');

    assert.equal(submitPayload?.requestId, 'wechat:bot_account_1:msg_reply_scope');
    assert.equal(submitPayload?.tool, 'codex');
    assert.equal(submitPayload?.model, 'ui-model-test');
    assert.equal(submitPayload?.effort, 'medium');
    assert.equal(submitPayload?.text, 'Please confirm the WeChat app scope.');
    assert.equal(submitPayload?.sourceDelivery?.connector, 'wechat',
      'submitWeChatMessageAsync must set sourceDelivery.connector=wechat');
    assert.equal(submitPayload?.sourceDelivery?.target?.accountId, 'bot_account_1');
    assert.equal(submitPayload?.sourceDelivery?.target?.peerUserId, 'wx_user_peer_1');
    assert.equal(receipt.sessionId, 'sess_wechat_1');
    assert.equal(receipt.requestId, 'wechat:bot_account_1:msg_reply_scope');
    assert.equal(publicationPollAttempted, false,
      'submitWeChatMessageAsync must NEVER call waitForConnectorPublication (no /responses/ poll)');
  } finally {
    globalThis.fetch = origFetch;
  }

  // --- Test: submitWeChatMessageAsync with image attachment ---
  let generatedImageAsset = null;
  replyRuntime.publishRemoteLabAsset = async (asset) => {
    generatedImageAsset = asset;
    return {
      id: 'asset_wechat_generated_1',
      mimeType: asset.mimeType,
      originalName: asset.originalName,
      sizeBytes: asset.body.length,
    };
  };
  await submitWeChatMessageAsync(replyRuntime, {
    accountId: 'bot_account_1',
    accountUserId: 'wx_user_owner_1',
    peerUserId: 'wx_user_peer_1',
    messageId: 'msg_image_generated_1',
    messageTypeNumeric: 1,
    messageType: 'user',
    messageStateNumeric: 2,
    messageState: 'finish',
    textPreview: '',
    contentSummary: '[image message]',
    imageResources: [{
      downloadUrl: `http://127.0.0.1:${port}/wechat-image.enc`,
      aesKey: imageKeyHex,
    }],
  });
  assert.deepEqual(generatedImageAsset?.body, imagePlaintext);
  assert.equal(submitPayload?.text, '[image message]');
  assert.equal(submitPayload?.attachments?.[0]?.assetId, 'asset_wechat_generated_1');
  assert.equal(submitPayload?.attachments?.[0]?.mimeType, 'image/jpeg');

  // --- Test: prepared-submission recovery (Feishu model) ---
  // Simulate a crash after session creation but before the HTTP response is received.
  // On retry, the same prepared payload must be re-used (no fingerprint conflict).
  let savedSubmission = null;
  const firstReceipt = await submitWeChatMessageAsync(replyRuntime, {
    accountId: 'bot_account_1',
    peerUserId: 'wx_user_peer_1',
    messageId: 'msg_prepared_test',
    messageTypeNumeric: 1,
    messageState: 'finish',
    messageStateNumeric: 2,
    textPreview: 'Test prepared payload.',
    imageResources: [],
  }, {
    saveSubmission: async (handoff) => { savedSubmission = handoff; },
  });
  assert.ok(savedSubmission, 'saveSubmission must be called before submitConnectorMessage');
  assert.equal(savedSubmission.sessionId, 'sess_wechat_1');
  assert.ok(savedSubmission.payload?.requestId, 'prepared payload must include requestId');

  // On retry, re-use the saved prepared payload.
  const retryReceipt = await submitWeChatMessageAsync(replyRuntime, {
    accountId: 'bot_account_1',
    peerUserId: 'wx_user_peer_1',
    messageId: 'msg_prepared_test',
    messageTypeNumeric: 1,
    messageState: 'finish',
    messageStateNumeric: 2,
    textPreview: 'Test prepared payload.',
    imageResources: [],
  }, {
    prepared: savedSubmission,
    saveSubmission: async () => { assert.fail('saveSubmission must not be called on retry'); },
  });
  assert.equal(retryReceipt.requestId, firstReceipt.requestId,
    'Retry must use the same requestId as the original submission (no fingerprint conflict)');

  // --- Test: handleWeChatMessageAsync unsupported payload is silently skipped ---
  let unsupportedHandled = null;
  await handleWeChatMessageAsync({
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
    imageResources: [],
  }, {
    wasMessageHandled: async () => false,
    markMessageHandled: async (_pathname, _messageKey, metadata) => {
      unsupportedHandled = metadata;
    },
    submitWeChatMessageAsync: async () => { assert.fail('must not submit unsupported message'); },
  });
  assert.equal(unsupportedHandled?.status, 'silent_no_reply');
  assert.equal(unsupportedHandled?.reason, 'unsupported_message_type');

  // --- Test: handleWeChatMessageAsync re-throws on submit failure (enables inbox retry) ---
  let submitFailureThrown = false;
  try {
    await handleWeChatMessageAsync({
      config,
      storagePaths: {
        ...config.storagePaths,
        handledMessagesPath: join(tempConfigDir, 'handled-submit-fail.json'),
      },
      accountsDoc,
      contextTokensDoc: contextDoc,
      processingMessageIds: new Set(),
    }, {
      accountId: 'bot_account_1',
      peerUserId: 'wx_user_peer_1',
      messageId: 'msg_submit_fail_1',
      messageTypeNumeric: 1,
      messageType: 'user',
      messageStateNumeric: 2,
      messageState: 'finish',
      textPreview: 'trigger submit failure',
      imageResources: [],
    }, {
      wasMessageHandled: async () => false,
      markMessageHandled: async () => {},
      submitWeChatMessageAsync: async () => {
        throw new Error('RemoteLab unavailable (test)');
      },
    });
  } catch {
    submitFailureThrown = true;
  }
  assert.ok(submitFailureThrown,
    'handleWeChatMessageAsync must re-throw submit errors so the inbox can retry');

  // --- Test: sendWeChatText uses stored contextToken ---
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

  const defaultTarget = await resolveDefaultWeChatTarget(sendRuntime);
  assert.deepEqual(defaultTarget, {
    accountId: 'bot_account_1',
    peerUserId: 'wx_user_owner_1',
  });
  const defaultSendResult = await sendDirectWeChatTextToDefaultBinding(
    sendRuntime,
    'Default bound user delivery.',
  );
  assert.match(defaultSendResult.message_id, /^remotelab-wechat-/);
  assert.equal(defaultSendResult.accountId, 'bot_account_1');
  assert.equal(defaultSendResult.peerUserId, 'wx_user_owner_1');
  assert.equal(sentIlinkPayload?.msg?.to_user_id, 'wx_user_owner_1');
  assert.equal(sentIlinkPayload?.msg?.item_list?.[0]?.text_item?.text, 'Default bound user delivery.');

  // --- Test: replayUnhandledMessages goes through inbox ---
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
        textPreview: '\u91cd\u542f\u540e\u8bf7\u8865\u53d1\u8fd9\u6761\u6d88\u606f\u3002',
        contentSummary: '\u91cd\u542f\u540e\u8bf7\u8865\u53d1\u8fd9\u6761\u6d88\u606f\u3002',
        itemTypes: ['text'],
      },
    }),
    '',
  ].join('\n'), 'utf8');

  const replayInboxAccepted = [];
  const replayInbox = {
    accept: async (id, entry) => { replayInboxAccepted.push({ id, messageId: entry.summary.messageId }); },
  };
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
    inbox: replayInbox,
  };
  const replayCount = await replayUnhandledMessages(replayRuntime, { accountIds: ['bot_account_1'] });
  assert.equal(replayCount, 1);
  assert.deepEqual(replayInboxAccepted.map(e => e.messageId), ['msg_replay_pending']);

  // --- Test: idle poller picks up newly linked accounts and submits via async path ---
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
  await saveAccountsDocument(idleConfig.storagePaths.accountsPath, {
    defaultAccountId: '',
    accounts: {},
  });
  const idleRuntime = createRuntimeContext(idleConfig, {
    accountsDoc: { defaultAccountId: '', accounts: {} },
    syncStateDoc: { accounts: {} },
    contextTokensDoc: { accounts: {} },
  });
  idleRuntime.authCookie = 'session_token=test-cookie';

  const activeAccountTransitions = [];
  const idleLoop = runPollLoop(idleRuntime, {
    durationMs: 300,
    onActiveAccountsChanged: async (accounts) => {
      activeAccountTransitions.push(accounts.map((account) => account.accountId));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await persistLinkedAccount(idleConfig, {
    connected: true,
    accountId: 'bot_account_1',
    botToken: 'bot_token_test_1',
    baseUrl: `http://127.0.0.1:${port}/bot-api`,
    userId: 'wx_user_owner_1',
  });
  await idleLoop;
  // Wait for inbox to finish processing any accepted messages.
  idleRuntime.inbox?.stop();
  await idleRuntime.inbox?.idle();

  assert.ok(getUpdatesCalls >= 1, 'idle poller should pick up linked accounts written after startup');
  assert.deepEqual(activeAccountTransitions[0], []);
  assert.deepEqual(activeAccountTransitions.at(-1), ['bot_account_1']);
  assert.equal(idleRuntime.accountsDoc.defaultAccountId, 'bot_account_1');
  assert.equal(createPayload?.sourceId, 'wechat',
    'idle loop must create RemoteLab session via async path');
  assert.equal(submitPayload?.requestId, 'wechat:bot_account_1:7448678501208393000',
    'idle loop must submit message to RemoteLab with correct requestId');
  assert.equal(submitPayload?.sourceDelivery?.connector, 'wechat',
    'idle loop async path must set sourceDelivery.connector=wechat (no publication wait)');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempConfigDir, { recursive: true, force: true });
  await rm(tempHome, { recursive: true, force: true });
}

console.log('ok - wechat connector config defaults load correctly');
console.log('ok - wechat qr login persists linked account state');
console.log('ok - pollAccountOnce accepts inbound messages into durable inbox (no chatQueues)');
console.log('ok - submitWeChatMessageAsync creates session and submits; no publication wait');
console.log('ok - submitWeChatMessageAsync uses prepared payload on retry (fingerprint stable)');
console.log('ok - outbound WeChat replies use stored contextToken');
console.log('ok - WeChat images are decrypted and submitted as RemoteLab attachments');
console.log('ok - unsupported non-text WeChat payloads remain safely ignored (async path)');
console.log('ok - handleWeChatMessageAsync re-throws submit errors for inbox retry');
console.log('ok - replayUnhandledMessages routes through durable inbox');
console.log('ok - idle WeChat workers pick up newly linked accounts without restart (async path)');
