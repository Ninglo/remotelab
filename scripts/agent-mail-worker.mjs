#!/usr/bin/env node

import { readFileSync } from 'fs';

import { AUTH_FILE } from '../lib/config.mjs';
import {
  APPROVED_QUEUE,
  DEFAULT_ROOT_DIR,
  buildEmailThreadExternalTriggerId,
  buildThreadReferencesHeader,
  decodeMaybeEncodedMailboxText,
  extractNormalizedMailboxContent,
  loadMailboxAutomation,
  listQueue,
  updateQueueItem,
} from '../lib/agent-mailbox.mjs';

function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const nextToken = argv[index + 1];
    const value = !nextToken || nextToken.startsWith('--') ? true : nextToken;
    if (value !== true) {
      index += 1;
    }
    options[key] = value;
  }

  return { positional, options };
}

function optionValue(options, key, fallbackValue = undefined) {
  const value = options[key];
  return value === undefined ? fallbackValue : value;
}

function nowIso() {
  return new Date().toISOString();
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printUsage() {
  console.log(`Usage:
  node scripts/agent-mail-worker.mjs [--root <dir>] [--chat-base-url <url>] [--interval-ms <ms>] [--once]

Examples:
  node scripts/agent-mail-worker.mjs --once
  node scripts/agent-mail-worker.mjs --interval-ms 5000`);
}

function readOwnerToken() {
  const auth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  const token = trimString(auth?.token);
  if (!token) {
    throw new Error(`No owner token found in ${AUTH_FILE}`);
  }
  return token;
}

function normalizeBaseUrl(baseUrl) {
  const normalized = trimString(baseUrl);
  if (!normalized) {
    throw new Error('chat base URL is required');
  }
  return normalized.replace(/\/+$/, '');
}

async function loginWithToken(baseUrl, token) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 302 || !setCookie) {
    throw new Error(`Failed to authenticate to chat server at ${baseUrl} (status ${response.status})`);
  }
  return setCookie.split(';')[0];
}

async function requestJson(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = {
    Accept: 'application/json',
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  return { response, json, text };
}

function buildReplySubject(subject) {
  const trimmed = trimString(subject);
  if (!trimmed) return '';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function buildSessionName(item) {
  const subject = trimString(item?.message?.subject);
  const sender = trimString(item?.message?.fromAddress);
  if (subject) return `Mail: ${subject}`;
  if (sender) return `Mail from ${sender}`;
  return 'Mail reply';
}

function buildSessionDescription(item, fallbackDescription) {
  const sender = trimString(item?.message?.fromAddress);
  const subject = trimString(item?.message?.subject);
  const fallback = trimString(fallbackDescription);
  return trimString(`Inbound email${sender ? ` from ${sender}` : ''}${subject ? ` about ${subject}` : ''}`) || fallback;
}

function extractReadableBodyFromRaw(item) {
  const rawPath = trimString(item?.storage?.rawPath);
  if (!rawPath) {
    return '';
  }

  try {
    const normalized = extractNormalizedMailboxContent({
      rawMessage: readFileSync(rawPath, 'utf8'),
    });
    return trimString(normalized.messageText) || trimString(normalized.previewText);
  } catch {
    return '';
  }
}

function buildReplyPrompt(item) {
  const sender = trimString(item?.message?.fromAddress);
  const subject = trimString(item?.message?.subject);
  const date = trimString(item?.message?.date);
  const messageId = trimString(item?.message?.messageId);
  const rawDerivedBody = extractReadableBodyFromRaw(item);
  const bodySource = trimString(item?.content?.extractedText) || trimString(item?.content?.preview);
  const decodedStoredBody = decodeMaybeEncodedMailboxText(bodySource, {
    contentType: trimString(item?.message?.headers?.['content-type']) || 'text/plain; charset=UTF-8',
    transferEncoding: trimString(item?.message?.headers?.['content-transfer-encoding']),
  });
  const body = rawDerivedBody || decodedStoredBody;

  return [
    'An approved inbound email needs a reply.',
    'Write the exact plain-text email body to send back to the sender.',
    'Keep the tone natural and helpful.',
    'Do not include email headers, markdown fences, or internal process notes.',
    '',
    'Inbound email metadata:',
    `- From: ${sender || '(unknown sender)'}`,
    `- Subject: ${subject || '(no subject)'}`,
    `- Date: ${date || '(no date)'}`,
    `- Message-ID: ${messageId || '(no message id)'}`,
    '',
    'Original email:',
    body || '(empty body)',
  ].join('\n');
}

function buildCompletionTarget(item, rootDir, requestId) {
  const messageId = trimString(item?.message?.messageId);
  const inReplyTo = trimString(item?.message?.inReplyTo);
  const references = trimString(item?.message?.replyReferences)
    || buildThreadReferencesHeader({
      messageId,
      inReplyTo,
      references: trimString(item?.message?.references),
    });
  return {
    id: `mailbox_email_${item.id}`,
    type: 'email',
    requestId,
    to: trimString(item?.message?.fromAddress),
    subject: buildReplySubject(item?.message?.subject),
    inReplyTo: messageId,
    references,
    mailboxRoot: rootDir,
    mailboxItemId: item.id,
  };
}

function shouldProcessItem(item) {
  const status = trimString(item?.status);
  const automationStatus = trimString(item?.automation?.status);
  if (!trimString(item?.message?.fromAddress)) return false;
  if (status === 'reply_sent' || automationStatus === 'reply_sent') return false;
  if (status === 'processing_for_reply' || automationStatus === 'processing_for_reply') return false;
  if (status === 'reply_failed' || automationStatus === 'reply_failed') return false;
  return true;
}

async function submitApprovedItem(item, rootDir, automation, baseUrl, cookie) {
  const requestId = trimString(item?.automation?.requestId) || `mailbox_reply_${item.id}`;
  const externalTriggerId = trimString(item?.message?.externalTriggerId)
    || buildEmailThreadExternalTriggerId({
      messageId: trimString(item?.message?.messageId),
      inReplyTo: trimString(item?.message?.inReplyTo),
      references: trimString(item?.message?.references),
    })
    || `mailbox:${item.id}`;
  const completionTarget = buildCompletionTarget(item, rootDir, requestId);
  const sessionPayload = {
    folder: automation.session.folder,
    tool: automation.session.tool,
    name: buildSessionName(item),
    group: automation.session.group,
    description: buildSessionDescription(item, automation.session.description),
    systemPrompt: automation.session.systemPrompt,
    completionTargets: [completionTarget],
    externalTriggerId,
  };

  const createResult = await requestJson(baseUrl, '/api/sessions', {
    method: 'POST',
    cookie,
    body: sessionPayload,
  });
  if (!createResult.response.ok || !createResult.json?.session?.id) {
    throw new Error(createResult.json?.error || createResult.text || `Failed to create session (${createResult.response.status})`);
  }

  const session = createResult.json.session;
  const messagePayload = {
    requestId,
    text: buildReplyPrompt(item),
    tool: automation.session.tool,
    thinking: automation.session.thinking === true,
  };
  if (trimString(automation.session.model)) {
    messagePayload.model = automation.session.model;
  }
  if (trimString(automation.session.effort)) {
    messagePayload.effort = automation.session.effort;
  }

  const submitResult = await requestJson(baseUrl, `/api/sessions/${session.id}/messages`, {
    method: 'POST',
    cookie,
    body: messagePayload,
  });
  if (![200, 202].includes(submitResult.response.status) || !submitResult.json?.run?.id) {
    throw new Error(submitResult.json?.error || submitResult.text || `Failed to submit session message (${submitResult.response.status})`);
  }

  const run = submitResult.json.run;
  updateQueueItem(item.id, rootDir, (draft) => {
    draft.status = 'processing_for_reply';
    draft.automation = {
      ...(draft.automation || {}),
      status: 'processing_for_reply',
      sessionId: session.id,
      runId: run.id,
      requestId,
      externalTriggerId,
      submittedAt: draft.automation?.submittedAt || nowIso(),
      duplicate: submitResult.json?.duplicate === true,
      lastError: null,
      updatedAt: nowIso(),
    };
    return draft;
  });

  return {
    itemId: item.id,
    sessionId: session.id,
    runId: run.id,
    duplicate: submitResult.json?.duplicate === true,
  };
}

async function runSweep({ rootDir, baseUrl }) {
  const automation = loadMailboxAutomation(rootDir);
  if (automation.enabled === false) {
    return {
      processed: 0,
      skipped: 0,
      failures: [],
      reason: 'automation_disabled',
    };
  }

  const token = readOwnerToken();
  const cookie = await loginWithToken(baseUrl, token);
  const approvedItems = listQueue(APPROVED_QUEUE, rootDir).filter(shouldProcessItem);
  const successes = [];
  const failures = [];

  for (const item of approvedItems) {
    try {
      successes.push(await submitApprovedItem(item, rootDir, automation, baseUrl, cookie));
    } catch (error) {
      updateQueueItem(item.id, rootDir, (draft) => {
        draft.status = 'reply_failed';
        draft.automation = {
          ...(draft.automation || {}),
          status: 'reply_failed',
          requestId: trimString(draft.automation?.requestId) || `mailbox_reply_${item.id}`,
          lastError: error.message,
          updatedAt: nowIso(),
        };
        return draft;
      });
      failures.push({ itemId: item.id, error: error.message });
    }
  }

  return {
    processed: successes.length,
    skipped: listQueue(APPROVED_QUEUE, rootDir).length - approvedItems.length,
    successes,
    failures,
  };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (positional[0] === 'help' || options.help || options.h) {
    printUsage();
    return;
  }

  const rootDir = optionValue(options, 'root', DEFAULT_ROOT_DIR);
  const automation = loadMailboxAutomation(rootDir);
  const baseUrl = optionValue(options, 'chat-base-url', automation.chatBaseUrl);
  const intervalMs = Math.max(1000, parseInt(optionValue(options, 'interval-ms', '5000'), 10) || 5000);
  const once = optionValue(options, 'once', false) === true;

  if (once) {
    console.log(JSON.stringify(await runSweep({ rootDir, baseUrl }), null, 2));
    return;
  }

  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runSweep({ rootDir, baseUrl });
      if (summary.processed > 0 || summary.failures.length > 0) {
        console.log(JSON.stringify(summary, null, 2));
      }
    } catch (error) {
      console.error(`[agent-mail-worker] ${error.message}`);
    } finally {
      running = false;
    }
  };

  await loop();
  setInterval(loop, intervalMs);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
