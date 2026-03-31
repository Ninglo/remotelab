#!/usr/bin/env node

import { createServer } from 'http';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ingestRawMessage, loadBridge, loadIdentity, mailboxPaths, summarizeQueueItem, DEFAULT_ROOT_DIR } from '../lib/agent-mailbox.mjs';
import { matchesWebhookToken, normalizeIp } from '../lib/agent-mail-http-bridge.mjs';
import { findMailboxRuntimeByAddress, loadMailboxRuntimeRegistry } from '../lib/mailbox-runtime-registry.mjs';

const HOST = process.env.AGENT_MAILBOX_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.AGENT_MAILBOX_PORT || '7694', 10);
const ROOT_DIR = process.env.AGENT_MAILBOX_ROOT || DEFAULT_ROOT_DIR;
const WEBHOOKS_DIR = join(ROOT_DIR, 'webhooks');
const EVENTS_FILE = join(ROOT_DIR, 'bridge-events.jsonl');
const MAX_BODY_BYTES = 12 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function ensureBridgePaths() {
  if (!existsSync(ROOT_DIR)) mkdirSync(ROOT_DIR, { recursive: true });
  if (!existsSync(WEBHOOKS_DIR)) mkdirSync(WEBHOOKS_DIR, { recursive: true });
}

function appendJsonl(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' });
}

function getClientIp(request) {
  const cfConnectingIp = request.headers['cf-connecting-ip'];
  if (cfConnectingIp) return normalizeIp(Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp);

  const forwardedFor = request.headers['x-forwarded-for'];
  if (forwardedFor) {
    const first = String(Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor).split(',')[0];
    return normalizeIp(first);
  }

  return normalizeIp(request.socket.remoteAddress || '');
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function singleHeaderValue(value) {
  return Array.isArray(value) ? trimString(value[0]) : trimString(value);
}

function currentBridgeConfig() {
  return loadBridge(ROOT_DIR) || {};
}

function currentCloudflareWebhookToken() {
  const bridge = currentBridgeConfig();
  return trimString(process.env.AGENT_MAILBOX_CLOUDFLARE_WEBHOOK_TOKEN || bridge.cloudflareWebhookToken);
}

function decodeRawEmailPayload(payload) {
  if (typeof payload.raw === 'string' && payload.raw.trim()) {
    return payload.raw;
  }
  if (typeof payload.rawBase64 === 'string' && payload.rawBase64.trim()) {
    return Buffer.from(payload.rawBase64, 'base64').toString('utf8');
  }
  return '';
}

function extractEnvelopeRecipient(payload = {}) {
  return trimString(
    payload?.envelope?.rcptTo
    || payload?.session?.recipient
    || (Array.isArray(payload?.recipients) ? payload.recipients[0] : ''),
  ).toLowerCase();
}

function resolveMailboxRootForPayload(payload = {}) {
  const recipientAddress = extractEnvelopeRecipient(payload);
  if (!recipientAddress) {
    return {
      rootDir: ROOT_DIR,
      recipientAddress: '',
      routedInstance: '',
      routeSource: 'default_root',
    };
  }

  const ownerIdentity = loadIdentity(ROOT_DIR);
  if (trimString(ownerIdentity?.address).toLowerCase() === recipientAddress) {
    return {
      rootDir: ROOT_DIR,
      recipientAddress,
      routedInstance: '',
      routeSource: 'owner_identity',
    };
  }

  const runtime = findMailboxRuntimeByAddress(recipientAddress, {
    registry: loadMailboxRuntimeRegistry(),
    ownerIdentity,
  });
  return {
    rootDir: trimString(runtime?.mailboxRoot) || ROOT_DIR,
    recipientAddress,
    routedInstance: trimString(runtime?.name),
    routeSource: runtime ? 'instance_mailbox_address' : 'default_root',
  };
}

function selectMailboxTargetForIngest(payload = {}) {
  const target = resolveMailboxRootForPayload(payload);
  if (!target.rootDir || target.rootDir === ROOT_DIR) {
    return target;
  }

  return {
    ...target,
    rootDir: ROOT_DIR,
    routeSource: 'instance_address_owner_queue',
    fallbackRootDir: ROOT_DIR,
    fallbackReason: loadIdentity(target.rootDir) ? 'owner_queue_preferred' : 'missing_identity',
  };
}

function sendJson(response, statusCode, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    request.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error(`Webhook body exceeded ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function summarizePayload(payload) {
  return {
    sender: payload.sender || payload?.session?.envelope?.mailFrom?.address || '',
    recipient: payload?.envelope?.rcptTo || payload?.session?.recipient || payload?.recipients?.[0] || '',
    subject: payload?.subject || payload?.headers?.subject || '',
    messageId: payload?.messageId || payload?.message_id || '',
  };
}

function recordExternalMailValidation(mailboxItem, sourceDetails = {}) {
  if (trimString(sourceDetails.reason) === 'loopback') {
    return;
  }

  const bridge = loadBridge(ROOT_DIR);
  if (!bridge) {
    return;
  }

  const validatedAt = nowIso();
  const nextBridge = {
    ...bridge,
    validation: {
      ...(bridge.validation || {}),
      queueReadyForRealMail: true,
      realExternalMailValidated: true,
      lastValidatedAt: validatedAt,
      lastExternalMailValidatedAt: validatedAt,
      lastExternalMail: summarizeQueueItem(mailboxItem),
      lastExternalSource: {
        ip: trimString(sourceDetails.ip),
        matchedHostname: trimString(sourceDetails.matchedHostname),
        reason: trimString(sourceDetails.reason),
      },
    },
    updatedAt: validatedAt,
  };

  writeFileSync(mailboxPaths(ROOT_DIR).bridgeFile, `${JSON.stringify(nextBridge, null, 2)}\n`, 'utf8');
}

async function handleCloudflareWebhook(request, response) {
  const expectedToken = currentCloudflareWebhookToken();
  const clientIp = getClientIp(request);
  if (!expectedToken) {
    sendJson(response, 503, {
      ok: false,
      error: 'cloudflare_webhook_unconfigured',
    });
    return;
  }

  const providedToken = singleHeaderValue(request.headers.authorization || request.headers['x-bridge-token']);
  if (!matchesWebhookToken(providedToken, expectedToken)) {
    appendJsonl(EVENTS_FILE, {
      event: 'rejected_invalid_cloudflare_webhook_token',
      createdAt: nowIso(),
      clientIp,
      path: request.url,
      method: request.method,
    });
    sendJson(response, 403, {
      ok: false,
      error: 'invalid_cloudflare_webhook_token',
    });
    return;
  }

  const bodyText = await readBody(request);
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(response, 400, {
      ok: false,
      error: 'invalid_json',
    });
    return;
  }

  const rawEmail = decodeRawEmailPayload(payload);
  if (!rawEmail) {
    sendJson(response, 400, {
      ok: false,
      error: 'missing_raw_email',
    });
    return;
  }

  ensureBridgePaths();
  const requestId = request.headers['cf-ray'] || payload.requestId || `${Date.now()}`;
  const safeRequestId = String(Array.isArray(requestId) ? requestId[0] : requestId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const webhookSnapshotPath = join(WEBHOOKS_DIR, `${safeRequestId}.json`);
  writeFileSync(webhookSnapshotPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const mailboxTarget = selectMailboxTargetForIngest(payload);
  const mailboxItem = ingestRawMessage(rawEmail, `cloudflare-email:${safeRequestId}`, mailboxTarget.rootDir, {
    text: payload.text,
    html: payload.html,
    provider: 'cloudflare_email_worker',
    envelope: payload.envelope,
  });
  recordExternalMailValidation(mailboxItem, {
    ip: clientIp,
    matchedHostname: 'cloudflare_email_worker',
    reason: clientIp === '127.0.0.1' || clientIp === '::1' ? 'loopback' : 'cloudflare_webhook_token',
  });

  appendJsonl(EVENTS_FILE, {
    event: 'accepted_cloudflare_email_webhook',
    createdAt: nowIso(),
    clientIp,
    requestId: safeRequestId,
    webhookSnapshotPath,
    mailboxRoot: mailboxTarget.rootDir,
    routedInstance: mailboxTarget.routedInstance,
    routeSource: mailboxTarget.routeSource,
    fallbackRootDir: trimString(mailboxTarget.fallbackRootDir),
    fallbackReason: trimString(mailboxTarget.fallbackReason),
    mailboxItem: summarizeQueueItem(mailboxItem),
    payload: summarizePayload(payload),
  });

  sendJson(response, 200, {
    ok: true,
    trustedSource: true,
    provider: 'cloudflare_email_worker',
    webhookSnapshotPath,
    mailboxRoot: mailboxTarget.rootDir,
    mailboxItem: summarizeQueueItem(mailboxItem),
  });
}

ensureBridgePaths();

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/healthz') {
      sendJson(response, 200, {
        ok: true,
        service: 'agent-mail-http-bridge',
        host: HOST,
        port: PORT,
        rootDir: ROOT_DIR,
        cloudflareWebhookConfigured: Boolean(currentCloudflareWebhookToken()),
        time: nowIso(),
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/cloudflare-email/webhook') {
      await handleCloudflareWebhook(request, response);
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: 'not_found',
      path: request.url,
    });
  } catch (error) {
    appendJsonl(EVENTS_FILE, {
      event: 'bridge_error',
      createdAt: nowIso(),
      message: error.message,
      stack: error.stack,
      path: request.url,
      method: request.method,
    });
    sendJson(response, 500, {
      ok: false,
      error: 'bridge_error',
      message: error.message,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[agent-mail-http-bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[agent-mail-http-bridge] mailbox root ${ROOT_DIR}`);
});
