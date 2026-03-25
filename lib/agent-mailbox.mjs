import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import {
  buildEmailThreadExternalTriggerId,
  buildThreadReferencesHeader,
  compactHeaders,
  decodeMaybeEncodedMailboxText,
  deriveEmailThreadKey,
  extractBestEffortBodyText,
  extractLatestReplySegment,
  extractPrimaryAddress,
  extractRawMessageImages,
  normalizeBodyPreview,
  parseHeaders,
  splitRawMessage,
} from './agent-mailbox-mime.mjs';
import { sanitizeGuestInstanceName } from './guest-instance.mjs';
import { summarizeOutboundConfig } from './agent-mail-outbound.mjs';

const DEFAULT_ROOT_DIR = join(homedir(), '.config', 'remotelab', 'agent-mailbox');
const REVIEW_QUEUE = 'review';
const QUARANTINE_QUEUE = 'quarantine';
const APPROVED_QUEUE = 'approved';
const KNOWN_QUEUES = [REVIEW_QUEUE, QUARANTINE_QUEUE, APPROVED_QUEUE];
const DEFAULT_OUTBOUND_CONFIG = {
  provider: 'cloudflare_worker',
  workerBaseUrl: '',
  account: '',
  from: '',
  workerToken: '',
  workerTokenEnv: 'REMOTELAB_CLOUDFLARE_EMAIL_WORKER_TOKEN',
};
const LEGACY_DEFAULT_AUTOMATION_SYSTEM_PROMPT = 'You are replying to an inbound email as Rowan. Write the exact plain-text email reply body to send back. Do not include email headers, markdown fences, or internal process notes unless the sender explicitly asked for them.';
const PREVIOUS_DEFAULT_AUTOMATION_SYSTEM_PROMPT = 'You are replying to an inbound email as Rowan. Take the time needed to fully solve the sender\'s request and reply thoroughly. Prefer completeness, careful troubleshooting, and explicit next steps over brevity or speed. Write the exact plain-text email reply body to send back. Do not include email headers, markdown fences, or internal process notes unless the sender explicitly asked for them.';
const DEFAULT_AUTOMATION_SETTINGS = {
  enabled: true,
  allowlistAutoApprove: false,
  autoApproveReviewer: 'mailbox-auto-approve',
  chatBaseUrl: 'http://127.0.0.1:7690',
  authFile: '',
  deliveryMode: 'reply_email',
  session: {
    folder: '~',
    tool: 'codex',
    group: 'Mail',
    description: 'Inbound agent mailbox conversations.',
    thinking: false,
    model: '',
    effort: '',
    systemPrompt: '',
  },
};
const MAX_MIME_NESTING_DEPTH = 8;

function mailboxPaths(rootDir = DEFAULT_ROOT_DIR) {
  return {
    rootDir,
    identityFile: join(rootDir, 'identity.json'),
    allowlistFile: join(rootDir, 'allowlist.json'),
    bridgeFile: join(rootDir, 'bridge.json'),
    outboundFile: join(rootDir, 'outbound.json'),
    automationFile: join(rootDir, 'automation.json'),
    eventsFile: join(rootDir, 'events.jsonl'),
    rawDir: join(rootDir, 'raw'),
    reviewDir: join(rootDir, REVIEW_QUEUE),
    quarantineDir: join(rootDir, QUARANTINE_QUEUE),
    approvedDir: join(rootDir, APPROVED_QUEUE),
  };
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function ensureMailboxRoot(rootDir = DEFAULT_ROOT_DIR) {
  const paths = mailboxPaths(rootDir);
  ensureDirectory(paths.rootDir);
  ensureDirectory(paths.rawDir);
  ensureDirectory(paths.reviewDir);
  ensureDirectory(paths.quarantineDir);
  ensureDirectory(paths.approvedDir);
  return paths;
}

function readJson(filePath, fallbackValue) {
  if (!existsSync(filePath)) {
    return fallbackValue;
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' });
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAutomationSystemPrompt(value) {
  const normalized = trimString(value);
  if (!normalized || normalized === LEGACY_DEFAULT_AUTOMATION_SYSTEM_PROMPT || normalized === PREVIOUS_DEFAULT_AUTOMATION_SYSTEM_PROMPT) {
    return DEFAULT_AUTOMATION_SETTINGS.session.systemPrompt;
  }
  return normalized;
}

function normalizeDeliveryMode(value) {
  const normalized = trimString(value).toLowerCase();
  if (normalized === 'session_only' || normalized === 'session-only' || normalized === 'session') {
    return 'session_only';
  }
  return 'reply_email';
}

function normalizeBoolean(value, fallbackValue = false) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = trimString(String(value)).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallbackValue;
}

function normalizeDomain(value) {
  return normalizeEmailAddress(value).replace(/^@+/, '');
}

function dedupeSorted(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deepClone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function mergeAutomationSettings(value = {}) {
  const session = {
    ...DEFAULT_AUTOMATION_SETTINGS.session,
    ...(value.session || {}),
  };
  return {
    ...DEFAULT_AUTOMATION_SETTINGS,
    ...(value || {}),
    session: {
      ...session,
      folder: trimString(session.folder) || DEFAULT_AUTOMATION_SETTINGS.session.folder,
      tool: trimString(session.tool) || DEFAULT_AUTOMATION_SETTINGS.session.tool,
      group: trimString(session.group) || DEFAULT_AUTOMATION_SETTINGS.session.group,
      description: trimString(session.description) || DEFAULT_AUTOMATION_SETTINGS.session.description,
      thinking: session.thinking === true,
      model: trimString(session.model),
      effort: trimString(session.effort),
      systemPrompt: normalizeAutomationSystemPrompt(session.systemPrompt),
    },
    chatBaseUrl: trimString(value.chatBaseUrl) || DEFAULT_AUTOMATION_SETTINGS.chatBaseUrl,
    authFile: trimString(value.authFile),
    deliveryMode: normalizeDeliveryMode(value.deliveryMode),
    enabled: normalizeBoolean(value.enabled, DEFAULT_AUTOMATION_SETTINGS.enabled),
    allowlistAutoApprove: normalizeBoolean(value.allowlistAutoApprove, DEFAULT_AUTOMATION_SETTINGS.allowlistAutoApprove),
    autoApproveReviewer: trimString(value.autoApproveReviewer) || DEFAULT_AUTOMATION_SETTINGS.autoApproveReviewer,
  };
}

function splitEmailAddressParts(value) {
  const normalized = normalizeEmailAddress(value);
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1) {
    return {
      address: '',
      localPart: '',
      domain: '',
    };
  }
  return {
    address: normalized,
    localPart: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
  };
}

function extractSubjectInstanceName(subject) {
  const trimmedSubject = trimString(subject);
  if (!trimmedSubject) return '';

  const explicitTagMatch = trimmedSubject.match(/^\[\s*instance\s*:\s*([^\]]+)\]/i);
  if (explicitTagMatch) {
    return sanitizeGuestInstanceName(explicitTagMatch[1]);
  }

  const shorthandTagMatch = trimmedSubject.match(/^\[\s*#\s*([^\]]+)\]/i);
  if (shorthandTagMatch) {
    return sanitizeGuestInstanceName(shorthandTagMatch[1]);
  }

  return '';
}

function deriveMailboxRouting({ identity, headerRecipientAddress, envelopeRecipientAddress, subject = '' }) {
  const identityLocalPart = trimString(identity?.localPart).toLowerCase();
  const identityDomain = normalizeDomain(identity?.domain);
  const headerToAddress = normalizeEmailAddress(headerRecipientAddress);
  const envelopeToAddress = normalizeEmailAddress(envelopeRecipientAddress);
  const effectiveRecipientAddress = envelopeToAddress || headerToAddress || normalizeEmailAddress(identity?.address);
  const effectiveParts = splitEmailAddressParts(effectiveRecipientAddress);
  const matchesMailboxDomain = !!identityLocalPart && !!identityDomain && effectiveParts.domain === identityDomain;

  let mailboxSubaddress = '';
  let instanceName = '';
  let matchedBy = '';
  if (matchesMailboxDomain && effectiveParts.localPart === identityLocalPart) {
    matchedBy = 'identity_address';
  }
  if (matchesMailboxDomain && effectiveParts.localPart.startsWith(`${identityLocalPart}+`)) {
    mailboxSubaddress = trimString(effectiveParts.localPart.slice(identityLocalPart.length + 1));
    instanceName = sanitizeGuestInstanceName(mailboxSubaddress);
    matchedBy = instanceName ? 'plus_address_instance' : 'plus_address';
  }
  if (!instanceName && matchesMailboxDomain && effectiveParts.localPart === identityLocalPart) {
    const subjectInstanceName = extractSubjectInstanceName(subject);
    if (subjectInstanceName) {
      mailboxSubaddress = subjectInstanceName;
      instanceName = subjectInstanceName;
      matchedBy = 'subject_instance_tag';
    }
  }

  return {
    headerToAddress,
    envelopeToAddress,
    effectiveRecipientAddress,
    mailboxSubaddress,
    instanceName,
    matchedBy,
  };
}

function normalizeOutboundConfig(value = {}) {
  return {
    ...DEFAULT_OUTBOUND_CONFIG,
    provider: trimString(value.provider) || DEFAULT_OUTBOUND_CONFIG.provider,
    workerBaseUrl: trimString(value.workerBaseUrl) || DEFAULT_OUTBOUND_CONFIG.workerBaseUrl,
    account: trimString(value.account),
    from: trimString(value.from),
    workerToken: trimString(value.workerToken),
    workerTokenEnv: trimString(value.workerTokenEnv) || DEFAULT_OUTBOUND_CONFIG.workerTokenEnv,
  };
}

function buildItemId(rawMessage) {
  return `mail_${Date.now()}_${sha256(rawMessage).slice(0, 12)}_${randomUUID().slice(0, 8)}`;
}

function loadIdentity(rootDir = DEFAULT_ROOT_DIR) {
  return readJson(mailboxPaths(rootDir).identityFile, null);
}

function loadBridge(rootDir = DEFAULT_ROOT_DIR) {
  return readJson(mailboxPaths(rootDir).bridgeFile, null);
}

function loadOutboundConfig(rootDir = DEFAULT_ROOT_DIR) {
  return normalizeOutboundConfig(readJson(mailboxPaths(rootDir).outboundFile, DEFAULT_OUTBOUND_CONFIG));
}

function saveOutboundConfig(rootDir = DEFAULT_ROOT_DIR, outboundConfig = {}) {
  const normalized = normalizeOutboundConfig(outboundConfig);
  writeJson(mailboxPaths(rootDir).outboundFile, normalized);
  return normalized;
}

function loadMailboxAutomation(rootDir = DEFAULT_ROOT_DIR) {
  return mergeAutomationSettings(readJson(mailboxPaths(rootDir).automationFile, DEFAULT_AUTOMATION_SETTINGS));
}

function saveMailboxAutomation(rootDir = DEFAULT_ROOT_DIR, automationSettings = {}) {
  const normalized = mergeAutomationSettings(automationSettings);
  writeJson(mailboxPaths(rootDir).automationFile, normalized);
  return normalized;
}

function loadAllowlist(rootDir = DEFAULT_ROOT_DIR) {
  const allowlist = readJson(mailboxPaths(rootDir).allowlistFile, {
    allowedEmails: [],
    allowedDomains: [],
    updatedAt: null,
  });

  return {
    allowedEmails: dedupeSorted((allowlist.allowedEmails || []).map(normalizeEmailAddress)),
    allowedDomains: dedupeSorted((allowlist.allowedDomains || []).map(normalizeDomain)),
    updatedAt: allowlist.updatedAt || null,
  };
}

function saveAllowlist(rootDir, allowlist) {
  const normalizedAllowlist = {
    allowedEmails: dedupeSorted((allowlist.allowedEmails || []).map(normalizeEmailAddress)),
    allowedDomains: dedupeSorted((allowlist.allowedDomains || []).map(normalizeDomain)),
    updatedAt: nowIso(),
  };
  writeJson(mailboxPaths(rootDir).allowlistFile, normalizedAllowlist);
  return normalizedAllowlist;
}

function matchAllowlist(senderAddress, allowlist) {
  if (!senderAddress) {
    return {
      allowed: false,
      ruleType: 'none',
      ruleValue: '',
    };
  }

  const senderDomain = senderAddress.split('@')[1] || '';
  if (allowlist.allowedEmails.includes(senderAddress)) {
    return {
      allowed: true,
      ruleType: 'email',
      ruleValue: senderAddress,
    };
  }

  if (allowlist.allowedDomains.includes(senderDomain)) {
    return {
      allowed: true,
      ruleType: 'domain',
      ruleValue: senderDomain,
    };
  }

  return {
    allowed: false,
    ruleType: 'none',
    ruleValue: '',
  };
}

function queuePathFromName(paths, queueName) {
  if (queueName === REVIEW_QUEUE) return paths.reviewDir;
  if (queueName === QUARANTINE_QUEUE) return paths.quarantineDir;
  if (queueName === APPROVED_QUEUE) return paths.approvedDir;
  throw new Error(`Unknown queue: ${queueName}`);
}

function markItemApproved(item, { reviewer, approvedAt = nowIso(), reviewStatus = 'approved', reasoning = 'Message was approved for AI processing.' } = {}) {
  const approvedTimestamp = trimString(approvedAt) || nowIso();
  item.queue = APPROVED_QUEUE;
  item.status = 'approved_for_ai';
  item.updatedAt = approvedTimestamp;
  item.security = {
    ...(item.security || {}),
    aiEligible: true,
    manualReviewRequired: false,
    reasoning,
  };
  item.review = {
    ...(item.review || {}),
    status: reviewStatus,
    approvedAt: approvedTimestamp,
    reviewer: trimString(reviewer) || null,
  };
  return item;
}

function extractNormalizedMailboxContent({ rawMessage, extractedText = '', extractedHtml = '' }) {
  const { headerText, bodyText } = splitRawMessage(String(rawMessage || ''));
  const headers = parseHeaders(headerText);
  const normalizedExtractedText = decodeMaybeEncodedMailboxText(trimString(extractedText), {
    contentType: headers['content-type'],
    transferEncoding: headers['content-transfer-encoding'],
  });
  const normalizedExtractedHtml = decodeMaybeEncodedMailboxText(trimString(extractedHtml), {
    contentType: 'text/html; charset=UTF-8',
  });
  const rawExtractedText = normalizedExtractedText
    || extractBestEffortBodyText(bodyText, headers['content-type'], headers['content-transfer-encoding']);
  const messageText = extractLatestReplySegment(rawExtractedText);
  const previewText = messageText || extractLatestReplySegment(normalizeBodyPreview(normalizedExtractedHtml, 'text/html'));

  return {
    bodyText,
    headers,
    messageText,
    previewText,
  };
}

function normalizeMessage({ rawMessage, sourcePath, identity, allowlist, automationSettings, extractedText = '', extractedHtml = '', metadata = {} }) {
  const { bodyText, headers, messageText, previewText } = extractNormalizedMailboxContent({
    rawMessage,
    extractedText,
    extractedHtml,
  });
  const extractedImages = extractRawMessageImages(rawMessage);
  const senderAddress = extractPrimaryAddress(headers.from);
  const recipientAddress = extractPrimaryAddress(headers.to);
  const routing = deriveMailboxRouting({
    identity,
    headerRecipientAddress: recipientAddress,
    envelopeRecipientAddress: extractPrimaryAddress(metadata?.envelope?.rcptTo),
    subject: headers.subject || '',
  });
  const allowMatch = matchAllowlist(senderAddress, allowlist);
  const automation = mergeAutomationSettings(automationSettings || {});
  const autoApproveAllowedSender = allowMatch.allowed && automation.allowlistAutoApprove === true;
  const queueName = allowMatch.allowed
    ? (autoApproveAllowedSender ? APPROVED_QUEUE : REVIEW_QUEUE)
    : QUARANTINE_QUEUE;
  const itemId = buildItemId(rawMessage);
  const createdAt = nowIso();

  const item = {
    id: itemId,
    queue: queueName,
    status: allowMatch.allowed
      ? (autoApproveAllowedSender ? 'approved_for_ai' : 'pending_manual_review')
      : 'quarantined_sender_not_allowlisted',
    createdAt,
    updatedAt: createdAt,
    identity: identity ? {
      name: identity.name,
      address: identity.address,
    } : null,
    source: {
      type: 'file',
      originalPath: sourcePath,
      fileName: basename(sourcePath),
    },
    message: {
      from: headers.from || '',
      fromAddress: senderAddress,
      to: headers.to || '',
      toAddress: recipientAddress,
      envelopeToAddress: routing.envelopeToAddress,
      effectiveToAddress: routing.effectiveRecipientAddress,
      subject: headers.subject || '',
      date: headers.date || '',
      messageId: headers['message-id'] || '',
      inReplyTo: headers['in-reply-to'] || '',
      references: headers.references || '',
      threadKey: deriveEmailThreadKey({
        messageId: headers['message-id'] || '',
        inReplyTo: headers['in-reply-to'] || '',
        references: headers.references || '',
      }),
      replyReferences: buildThreadReferencesHeader({
        messageId: headers['message-id'] || '',
        inReplyTo: headers['in-reply-to'] || '',
        references: headers.references || '',
      }),
      externalTriggerId: buildEmailThreadExternalTriggerId({
        messageId: headers['message-id'] || '',
        inReplyTo: headers['in-reply-to'] || '',
        references: headers.references || '',
      }),
      headers: compactHeaders(headers),
    },
    routing: {
      recipientAddress: routing.effectiveRecipientAddress,
      mailboxSubaddress: routing.mailboxSubaddress,
      instanceName: routing.instanceName,
      matchedBy: routing.matchedBy,
    },
    security: {
      senderAllowed: allowMatch.allowed,
      matchedRule: allowMatch.ruleType,
      matchedValue: allowMatch.ruleValue,
      aiEligible: autoApproveAllowedSender,
      manualReviewRequired: !autoApproveAllowedSender,
      reasoning: autoApproveAllowedSender
        ? 'Sender matched the allowlist and mailbox automation auto-approved the message for AI processing.'
        : allowMatch.allowed
          ? 'Sender matched the allowlist, but the message still waits for manual review before any AI processing.'
        : 'Sender did not match the allowlist and has been quarantined before AI processing.',
    },
    review: {
      status: autoApproveAllowedSender
        ? 'auto_approved'
        : allowMatch.allowed
          ? 'pending'
          : 'blocked',
      approvedAt: autoApproveAllowedSender ? createdAt : null,
      reviewer: autoApproveAllowedSender ? automation.autoApproveReviewer : null,
    },
    content: {
      preview: previewText.slice(0, 1200),
      extractedText: messageText,
      ...(extractedImages.length > 0 ? { images: extractedImages } : {}),
      rawBytes: Buffer.byteLength(rawMessage),
      bodyBytes: Buffer.byteLength(bodyText),
      rawSha256: sha256(rawMessage),
      bodySha256: sha256(bodyText),
    },
    storage: {
      rawPath: '',
    },
  };

  if (autoApproveAllowedSender) {
    markItemApproved(item, {
      reviewer: automation.autoApproveReviewer,
      approvedAt: createdAt,
      reviewStatus: 'auto_approved',
      reasoning: 'Sender matched the allowlist and mailbox automation auto-approved the message for AI processing.',
    });
  }

  return item;
}

function ingestRawMessage(rawMessage, sourcePath, rootDir = DEFAULT_ROOT_DIR, metadata = {}) {
  const paths = ensureMailboxRoot(rootDir);
  const identity = loadIdentity(rootDir);
  if (!identity) {
    throw new Error(`Mailbox identity not initialized. Run init first: ${paths.identityFile}`);
  }

  const allowlist = loadAllowlist(rootDir);
  const automation = loadMailboxAutomation(rootDir);
  const normalizedItem = normalizeMessage({
    rawMessage,
    sourcePath,
    identity,
    allowlist,
    automationSettings: automation,
    extractedText: metadata.text,
    extractedHtml: metadata.html,
    metadata,
  });
  const duplicate = findDuplicateQueueItem(normalizedItem, rootDir);
  if (duplicate) {
    appendJsonl(paths.eventsFile, {
      event: 'duplicate_ignored',
      id: normalizedItem.id,
      existingId: duplicate.item.id,
      queue: duplicate.queueName,
      reason: duplicate.reason,
      createdAt: nowIso(),
      sender: normalizedItem.message.fromAddress,
      subject: normalizedItem.message.subject,
      sourcePath,
      messageId: normalizedItem.message.messageId,
    });
    return duplicate.item;
  }
  const rawTargetPath = join(paths.rawDir, `${normalizedItem.id}.eml`);
  const jsonTargetPath = join(queuePathFromName(paths, normalizedItem.queue), `${normalizedItem.id}.json`);

  writeFileSync(rawTargetPath, rawMessage, 'utf8');
  normalizedItem.storage.rawPath = rawTargetPath;
  writeJson(jsonTargetPath, normalizedItem);
  appendJsonl(paths.eventsFile, {
    event: 'ingested',
    id: normalizedItem.id,
    queue: normalizedItem.queue,
    createdAt: normalizedItem.createdAt,
    sender: normalizedItem.message.fromAddress,
    subject: normalizedItem.message.subject,
    sourcePath,
  });
  if (normalizedItem.review?.status === 'auto_approved') {
    appendJsonl(paths.eventsFile, {
      event: 'auto_approved',
      id: normalizedItem.id,
      createdAt: normalizedItem.createdAt,
      reviewer: normalizedItem.review.reviewer,
      sender: normalizedItem.message.fromAddress,
      subject: normalizedItem.message.subject,
    });
  }

  return normalizedItem;
}

function ingestFile(sourcePath, rootDir = DEFAULT_ROOT_DIR) {
  return ingestRawMessage(readFileSync(sourcePath, 'utf8'), sourcePath, rootDir);
}

function ingestSource(sourcePath, rootDir = DEFAULT_ROOT_DIR) {
  const sourceStats = statSync(sourcePath);
  if (sourceStats.isDirectory()) {
    const filePaths = readdirSync(sourcePath)
      .map((fileName) => join(sourcePath, fileName))
      .filter((filePath) => statSync(filePath).isFile())
      .sort((left, right) => left.localeCompare(right));

    return filePaths.map((filePath) => ingestFile(filePath, rootDir));
  }

  return [ingestFile(sourcePath, rootDir)];
}

function listQueue(queueName = REVIEW_QUEUE, rootDir = DEFAULT_ROOT_DIR) {
  const paths = ensureMailboxRoot(rootDir);
  const directoryPath = queuePathFromName(paths, queueName);
  return readdirSync(directoryPath)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => readJson(join(directoryPath, fileName), null))
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function queueCounts(rootDir = DEFAULT_ROOT_DIR) {
  return Object.fromEntries(KNOWN_QUEUES.map((queueName) => [queueName, listQueue(queueName, rootDir).length]));
}

function findDuplicateQueueItem(candidateItem, rootDir = DEFAULT_ROOT_DIR) {
  const candidateMessageId = trimString(candidateItem?.message?.messageId);
  const candidateRawSha256 = trimString(candidateItem?.content?.rawSha256);
  if (!candidateMessageId && !candidateRawSha256) {
    return null;
  }

  for (const queueName of KNOWN_QUEUES) {
    for (const item of listQueue(queueName, rootDir)) {
      if (!item || item.id === candidateItem?.id) continue;
      if (candidateMessageId && trimString(item?.message?.messageId) === candidateMessageId) {
        return {
          item,
          queueName,
          reason: 'message_id',
        };
      }
      if (candidateRawSha256 && trimString(item?.content?.rawSha256) === candidateRawSha256) {
        return {
          item,
          queueName,
          reason: 'raw_sha256',
        };
      }
    }
  }

  return null;
}

function findQueueItem(id, rootDir = DEFAULT_ROOT_DIR) {
  const paths = ensureMailboxRoot(rootDir);
  for (const queueName of KNOWN_QUEUES) {
    const filePath = join(queuePathFromName(paths, queueName), `${id}.json`);
    if (!existsSync(filePath)) continue;
    const item = readJson(filePath, null);
    if (!item) continue;
    return { item, queueName, filePath };
  }
  return null;
}

function updateQueueItem(id, rootDir = DEFAULT_ROOT_DIR, updater = (item) => item) {
  const located = findQueueItem(id, rootDir);
  if (!located) {
    throw new Error(`Queue item not found: ${id}`);
  }

  const draft = deepClone(located.item);
  const updated = updater(draft, located.item);
  const nextItem = updated && typeof updated === 'object' ? updated : draft;
  nextItem.updatedAt = nowIso();
  writeJson(located.filePath, nextItem);
  return nextItem;
}

function assessMailboxPublicIngress(identity, bridge) {
  const diagnostics = [];
  const assessment = {
    diagnostics,
    effectiveStatus: identity?.status || null,
    publicIngress: bridge ? 'bridge_configured' : 'not_configured',
  };

  if (!bridge) {
    return assessment;
  }

  if (bridge.validation?.realExternalMailValidated) {
    assessment.effectiveStatus = 'external_mail_validated';
    assessment.publicIngress = 'external_mail_validated';
    return assessment;
  }

  if (bridge.validation?.queueReadyForRealMail) {
    assessment.effectiveStatus = 'ready_for_external_mail';
    assessment.publicIngress = 'ready_for_external_mail';
    return assessment;
  }

  if (bridge.validation?.publicHealth === 'pass') {
    assessment.effectiveStatus = 'public_webhook_healthy';
    assessment.publicIngress = 'public_webhook_healthy';
    return assessment;
  }

  assessment.publicIngress = 'bridge_configured_pending_validation';
  return assessment;
}

function summarizeBridgeConfig(bridge) {
  if (!bridge || typeof bridge !== 'object') return bridge;
  return {
    ...bridge,
    cloudflareWebhookToken: trimString(bridge.cloudflareWebhookToken) ? '[configured]' : '',
  };
}

function getMailboxStatus(rootDir = DEFAULT_ROOT_DIR) {
  const identity = loadIdentity(rootDir);
  const allowlist = loadAllowlist(rootDir);
  const bridge = loadBridge(rootDir);
  const outbound = loadOutboundConfig(rootDir);
  const automation = loadMailboxAutomation(rootDir);
  const reviewItems = listQueue(REVIEW_QUEUE, rootDir);
  const quarantineItems = listQueue(QUARANTINE_QUEUE, rootDir);
  const approvedItems = listQueue(APPROVED_QUEUE, rootDir);
  const ingress = assessMailboxPublicIngress(identity, bridge);

  return {
    rootDir,
    identity,
    allowlist,
    bridge: summarizeBridgeConfig(bridge),
    outbound: summarizeOutboundConfig(outbound),
    automation,
    counts: queueCounts(rootDir),
    latest: {
      review: reviewItems[0] ? summarizeQueueItem(reviewItems[0]) : null,
      quarantine: quarantineItems[0] ? summarizeQueueItem(quarantineItems[0]) : null,
      approved: approvedItems[0] ? summarizeQueueItem(approvedItems[0]) : null,
    },
    effectiveStatus: ingress.effectiveStatus,
    publicIngress: ingress.publicIngress,
    diagnostics: ingress.diagnostics,
  };
}

function initializeMailbox({ rootDir = DEFAULT_ROOT_DIR, name, localPart, domain, description, allowEmails = [], allowDomains = [] }) {
  if (!name || !localPart || !domain) {
    throw new Error('init requires --name, --local-part, and --domain');
  }

  const paths = ensureMailboxRoot(rootDir);
  const createdAt = nowIso();
  const normalizedLocalPart = String(localPart).trim().toLowerCase();
  const normalizedDomain = String(domain).trim().toLowerCase();
  const identity = {
    name: String(name).trim(),
    localPart: normalizedLocalPart,
    domain: normalizedDomain,
    address: `${normalizedLocalPart}@${normalizedDomain}`,
    description: description || 'Agent-facing mailbox identity for RemoteLab collaboration.',
    createdAt,
    updatedAt: createdAt,
    status: 'local_intake_ready_public_dns_pending',
  };

  const allowlist = saveAllowlist(rootDir, {
    allowedEmails: allowEmails,
    allowedDomains: allowDomains,
  });

  writeJson(paths.identityFile, identity);
  appendJsonl(paths.eventsFile, {
    event: 'initialized',
    createdAt,
    identity: {
      name: identity.name,
      address: identity.address,
    },
    allowlist,
  });

  return {
    rootDir,
    identity,
    allowlist,
  };
}

function addAllowEntry(entry, rootDir = DEFAULT_ROOT_DIR) {
  const currentAllowlist = loadAllowlist(rootDir);
  if (String(entry).includes('@')) {
    currentAllowlist.allowedEmails.push(normalizeEmailAddress(entry));
  } else {
    currentAllowlist.allowedDomains.push(normalizeDomain(entry));
  }

  const savedAllowlist = saveAllowlist(rootDir, currentAllowlist);
  appendJsonl(mailboxPaths(rootDir).eventsFile, {
    event: 'allowlist_updated',
    createdAt: nowIso(),
    entry,
    allowlist: savedAllowlist,
  });
  return savedAllowlist;
}

function approveMessage(id, rootDir = DEFAULT_ROOT_DIR, reviewer = 'manual-operator') {
  const paths = ensureMailboxRoot(rootDir);
  const reviewPath = join(paths.reviewDir, `${id}.json`);
  if (!existsSync(reviewPath)) {
    throw new Error(`Review item not found: ${id}`);
  }

  const item = readJson(reviewPath, null);
  if (!item) {
    throw new Error(`Could not read review item: ${id}`);
  }

  const approvedPath = join(paths.approvedDir, `${id}.json`);
  renameSync(reviewPath, approvedPath);
  markItemApproved(item, {
    reviewer,
    reviewStatus: 'approved',
    reasoning: 'Message was manually approved for AI processing.',
  });
  writeJson(approvedPath, item);
  appendJsonl(paths.eventsFile, {
    event: 'approved',
    id,
    createdAt: item.updatedAt,
    reviewer,
    sender: item.message.fromAddress,
    subject: item.message.subject,
  });
  return item;
}

function summarizeQueueItem(item) {
  return {
    id: item.id,
    queue: item.queue,
    status: item.status,
    from: item.message.fromAddress,
    to: trimString(item?.message?.effectiveToAddress) || trimString(item?.message?.envelopeToAddress) || trimString(item?.message?.toAddress),
    subject: item.message.subject,
    targetInstance: trimString(item?.routing?.instanceName),
    createdAt: item.createdAt,
  };
}

export {
  APPROVED_QUEUE,
  DEFAULT_ROOT_DIR,
  DEFAULT_AUTOMATION_SETTINGS,
  DEFAULT_OUTBOUND_CONFIG,
  KNOWN_QUEUES,
  QUARANTINE_QUEUE,
  REVIEW_QUEUE,
  addAllowEntry,
  assessMailboxPublicIngress,
  approveMessage,
  buildEmailThreadExternalTriggerId,
  buildThreadReferencesHeader,
  decodeMaybeEncodedMailboxText,
  ensureMailboxRoot,
  extractNormalizedMailboxContent,
  extractRawMessageImages,
  findQueueItem,
  getMailboxStatus,
  initializeMailbox,
  ingestRawMessage,
  ingestSource,
  listQueue,
  loadAllowlist,
  loadMailboxAutomation,
  loadBridge,
  loadIdentity,
  loadOutboundConfig,
  mailboxPaths,
  queueCounts,
  saveMailboxAutomation,
  saveOutboundConfig,
  summarizeQueueItem,
  updateQueueItem,
};
