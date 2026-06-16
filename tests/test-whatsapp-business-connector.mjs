#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = await mkdtemp(join(tmpdir(), 'remotelab-whatsapp-business-home-'));
const tempConfigDir = join(tempHome, '.config', 'remotelab');
const tempConnectorDir = join(tempConfigDir, 'whatsapp-business-connector');
const tempConfigPath = join(tempConnectorDir, 'config.json');

process.env.HOME = tempHome;
process.env.REMOTELAB_CONFIG_DIR = tempConfigDir;

const {
  collectWebhookMessages,
  createRuntimeContext,
  generateRemoteLabReply,
  handleWebhookPayload,
  loadConfig,
  sendWhatsAppText,
  startWhatsAppBusinessSurfaceServer,
  subscribeAppToWaba,
  verifyWebhookSignature,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'whatsapp-business-connector.mjs')).href);

let createPayload = null;
let submitPayload = null;
let subscribeCalls = 0;
let outboundPayloads = [];
let surfaceServer = null;

const server = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  await new Promise((resolve) => req.on('end', resolve));

  if (req.method === 'GET' && req.url?.startsWith('/?token=')) {
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': 'session_token=test-session; Path=/; HttpOnly',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions') {
    createPayload = JSON.parse(body || '{}');
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: {
        id: 'sess_whatsapp_1',
      },
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_whatsapp_1/messages') {
    submitPayload = JSON.parse(body || '{}');
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      response: { id: 'resp_whatsapp_1' },
      run: { id: 'run_whatsapp_1' },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_whatsapp_1/responses/resp_whatsapp_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      replyPublication: {
        id: 'resp_whatsapp_1',
        state: 'ready',
        finalRunId: 'run_whatsapp_1',
        payload: {
          text: '<private>hidden</private> 已处理。',
        },
      },
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/graph/v23.0/phone_number_1/messages') {
    outboundPayloads.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      messaging_product: 'whatsapp',
      messages: [{ id: `wamid.${outboundPayloads.length}` }],
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/graph/v23.0/waba_1/subscribed_apps') {
    subscribeCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

function waitFor(predicate, timeoutMs = 5000, intervalMs = 50) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        const result = await predicate();
        if (result) {
          resolve(result);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('Timed out'));
          return;
        }
        setTimeout(tick, intervalMs);
      } catch (error) {
        reject(error);
      }
    };
    void tick();
  });
}

try {
  const port = server.address().port;
  await writeFile(join(tempConfigDir, 'auth.json'), JSON.stringify({ token: 'owner_token_1' }, null, 2));

  const loaded = await loadConfig(tempConfigPath);
  assert.equal(loaded.graphVersion, 'v23.0', 'default graph version should be written when config is missing');
  assert.equal(
    JSON.parse(await readFile(tempConfigPath, 'utf8')).sessionTool,
    'codex',
    'missing config should be bootstrapped to disk',
  );

  const runtime = await createRuntimeContext({
    ...loaded,
    configPath: tempConfigPath,
    chatBaseUrl: `http://127.0.0.1:${port}`,
    graphApiBaseUrl: `http://127.0.0.1:${port}/graph`,
    accessToken: 'test_access_token',
    appSecret: 'test_app_secret',
    verifyToken: 'test_verify_token',
    phoneNumberId: 'phone_number_1',
    wabaId: 'waba_1',
  });

  surfaceServer = await startWhatsAppBusinessSurfaceServer(runtime);
  assert.ok(surfaceServer?.baseUrl, 'surface server should start for the connector');
  const surfacePage = await fetch(`${surfaceServer.baseUrl}/`);
  const surfaceHtml = await surfacePage.text();
  assert.match(
    surfaceHtml,
    /This page is only for the internal platform-side bind\./,
    'setup page should explain that the bind page is internal',
  );
  assert.match(
    surfaceHtml,
    /Prepare only these values/,
    'setup page should stay in minimal mode',
  );
  assert.match(
    surfaceHtml,
    /Generate token/,
    'setup page should expose verify-token generation',
  );
  assert.doesNotMatch(
    surfaceHtml,
    /Session folder/,
    'minimal bind page should not expose advanced runtime fields',
  );

  const webhookPayload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba_1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '+1 650 555 0000',
            phone_number_id: 'phone_number_1',
          },
          contacts: [{
            profile: { name: 'Alice' },
            wa_id: '16505550001',
          }],
          messages: [{
            from: '16505550001',
            id: 'wamid.inbound_1',
            timestamp: '1710000000',
            type: 'text',
            text: { body: '帮我看一下实例状态' },
          }],
        },
      }],
    }],
  };

  const summaries = collectWebhookMessages(webhookPayload);
  assert.equal(summaries.length, 1, 'webhook payload should normalize exactly one inbound message');
  assert.equal(summaries[0].profileName, 'Alice');
  assert.equal(summaries[0].normalizedText, '帮我看一下实例状态');
  assert.equal(summaries[0].phoneNumberId, 'phone_number_1');

  const rawBody = Buffer.from(JSON.stringify(webhookPayload));
  const signature = `sha256=${(await import('crypto')).createHmac('sha256', 'test_app_secret').update(rawBody).digest('hex')}`;
  assert.equal(
    verifyWebhookSignature(rawBody, signature, 'test_app_secret'),
    true,
    'valid webhook signature should verify',
  );
  assert.equal(
    verifyWebhookSignature(rawBody, signature, 'other_secret'),
    false,
    'mismatched webhook signature should fail',
  );

  const directSend = await sendWhatsAppText(runtime, {
    phoneNumberId: 'phone_number_1',
    to: '16505550001',
  }, 'hello');
  assert.equal(directSend.messages[0].id, 'wamid.1', 'direct send should hit the graph endpoint');
  assert.equal(outboundPayloads[0].text.body, 'hello');

  outboundPayloads = [];
  const generated = await generateRemoteLabReply(runtime, summaries[0]);
  assert.equal(generated.replyText, '已处理。', 'reply publication text should strip hidden blocks');
  assert.equal(createPayload.sourceId, 'whatsapp');
  assert.equal(createPayload.externalTriggerId, 'whatsapp:phone_number_1:16505550001');
  assert.equal(submitPayload.text, '帮我看一下实例状态');

  await handleWebhookPayload(runtime, webhookPayload);
  await waitFor(() => outboundPayloads.length === 1);
  await waitFor(() => runtime.handledMessagesDoc.messages['wamid.inbound_1']);
  assert.equal(outboundPayloads[0].to, '16505550001', 'webhook processing should reply to the inbound wa_id');
  assert.equal(outboundPayloads[0].text.body, '已处理。', 'webhook processing should send the RemoteLab reply back to WhatsApp');

  const handledDoc = JSON.parse(await readFile(join(tempConnectorDir, 'handled-messages.json'), 'utf8'));
  assert.equal(
    handledDoc.messages['wamid.inbound_1'].status,
    'sent',
    'processed inbound messages should be persisted as handled',
  );

  const subscribeResponse = await subscribeAppToWaba(runtime);
  assert.equal(subscribeResponse.success, true);
  assert.equal(subscribeCalls, 1, 'subscribe helper should call the WABA subscribed_apps endpoint');

  console.log('test-whatsapp-business-connector: ok');
} finally {
  await surfaceServer?.stop?.();
  server.close();
  await rm(tempHome, { recursive: true, force: true });
}
