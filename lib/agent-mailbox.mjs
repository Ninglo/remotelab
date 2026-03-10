import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
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
const DEFAULT_AUTOMATION_SETTINGS = {
  enabled: true,
  allowlistAutoApprove: false,
  autoApproveReviewer: 'mailbox-auto-approve',
  chatBaseUrl: 'http://127.0.0.1:7690',
  session: {
    folder: '~',
    tool: 'codex',
    group: 'Mail',
    description: 'Inbound agent mailbox conversations.',
    thinking: false,
    model: '',
    effort: '',
    systemPrompt: 'You are replying to an inbound email as Rowan. Write the exact plain-text email reply body to send back. Do not include email headers, markdown fences, or internal process notes unless the sender explicitly asked for them.',
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
      systemPrompt: trimString(session.systemPrompt) || DEFAULT_AUTOMATION_SETTINGS.session.systemPrompt,
    },
    chatBaseUrl: trimString(value.chatBaseUrl) || DEFAULT_AUTOMATION_SETTINGS.chatBaseUrl,
    enabled: normalizeBoolean(value.enabled, DEFAULT_AUTOMATION_SETTINGS.enabled),
    allowlistAutoApprove: normalizeBoolean(value.allowlistAutoApprove, DEFAULT_AUTOMATION_SETTINGS.allowlistAutoApprove),
    autoApproveReviewer: trimString(value.autoApproveReviewer) || DEFAULT_AUTOMATION_SETTINGS.autoApproveReviewer,
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

function splitRawMessage(rawMessage) {
  const windowsDelimiterIndex = rawMessage.indexOf('\r\n\r\n');
  if (windowsDelimiterIndex !== -1) {
    return {
      headerText: rawMessage.slice(0, windowsDelimiterIndex),
      bodyText: rawMessage.slice(windowsDelimiterIndex + 4),
    };
  }

  const unixDelimiterIndex = rawMessage.indexOf('\n\n');
  if (unixDelimiterIndex !== -1) {
    return {
      headerText: rawMessage.slice(0, unixDelimiterIndex),
      bodyText: rawMessage.slice(unixDelimiterIndex + 2),
    };
  }

  return {
    headerText: rawMessage,
    bodyText: '',
  };
}

function parseHeaders(headerText) {
  const lines = headerText.split(/\r?\n/);
  const headers = {};
  let currentName = '';

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (/^[\t ]/.test(line) && currentName) {
      headers[currentName] = `${headers[currentName]} ${line.trim()}`;
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    currentName = line.slice(0, separatorIndex).trim().toLowerCase();
    headers[currentName] = line.slice(separatorIndex + 1).trim();
  }

  return headers;
}

function extractPrimaryAddress(headerValue) {
  const match = String(headerValue || '').match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i);
  return normalizeEmailAddress(match ? match[0] : '');
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractCharset(contentType) {
  const match = String(contentType || '').match(/charset=(?:"([^"]+)"|([^;]+))/i);
  return trimString(match?.[1] || match?.[2]).replace(/^['"]|['"]$/g, '');
}

function normalizeCharsetLabel(charset) {
  const normalized = trimString(charset).toLowerCase();
  if (!normalized) return 'utf-8';
  const aliases = {
    utf8: 'utf-8',
    'us-ascii': 'utf-8',
    ascii: 'utf-8',
    latin1: 'windows-1252',
    'iso-8859-1': 'windows-1252',
    gb2312: 'gbk',
  };
  return aliases[normalized] || normalized;
}

function decodeBytesWithCharset(bytes, contentType = '') {
  const charset = normalizeCharsetLabel(extractCharset(contentType));
  const labels = [charset];
  if (charset === 'gbk') labels.push('gb18030');
  if (!labels.includes('utf-8')) labels.push('utf-8');
  if (!labels.includes('windows-1252')) labels.push('windows-1252');

  for (const label of labels) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {}
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeQuotedPrintableBytes(text) {
  const normalized = String(text || '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const hex = normalized.slice(index + 1, index + 3);
    if (char === '=' && /^[A-F0-9]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(normalized.charCodeAt(index) & 0xFF);
  }
  return Uint8Array.from(bytes);
}

function cleanBase64Text(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

function decodeBase64Bytes(text) {
  const normalized = cleanBase64Text(text);
  if (!normalized || normalized.length < 16 || normalized.length % 4 !== 0) return null;
  if (/[^A-Za-z0-9+/=]/.test(normalized)) return null;
  try {
    const buffer = Buffer.from(normalized, 'base64');
    if (buffer.length === 0) return null;
    const canonicalInput = normalized.replace(/=+$/g, '');
    const canonicalDecoded = buffer.toString('base64').replace(/=+$/g, '');
    if (canonicalInput !== canonicalDecoded) return null;
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

function looksLikeReadableText(text) {
  const value = String(text || '');
  const trimmed = trimString(value);
  if (!trimmed) return false;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(trimmed)) return false;
  if (trimmed.includes('\uFFFD')) return false;

  const chars = Array.from(trimmed);
  let readable = 0;
  for (const char of chars) {
    const code = char.charCodeAt(0);
    if (char === '\n' || char === '\r' || char === '\t') {
      readable += 1;
      continue;
    }
    if (code >= 0x20 && code !== 0x7F) {
      readable += 1;
    }
  }
  return readable / chars.length >= 0.9 && /[\p{L}\p{N}]/u.test(trimmed);
}

function looksLikeQuotedPrintableText(text) {
  return /(=(?:[A-F0-9]{2})){3,}/i.test(String(text || ''));
}

function looksLikeBase64Text(text) {
  const normalized = cleanBase64Text(text);
  return normalized.length >= 16
    && normalized.length % 4 === 0
    && /[+/=]/.test(normalized)
    && !/[^A-Za-z0-9+/=]/.test(normalized);
}

function decodeTransferEncodedText(text, { contentType = '', transferEncoding = '' } = {}) {
  const normalizedEncoding = trimString(transferEncoding).toLowerCase();
  if (normalizedEncoding === 'quoted-printable') {
    return decodeBytesWithCharset(decodeQuotedPrintableBytes(text), contentType);
  }
  if (normalizedEncoding === 'base64') {
    const bytes = decodeBase64Bytes(text);
    return bytes ? decodeBytesWithCharset(bytes, contentType) : String(text || '');
  }
  return String(text || '');
}

function decodeMaybeEncodedMailboxText(text, options = {}) {
  const raw = String(text || '');
  if (!raw) return raw;

  const normalizedEncoding = trimString(options.transferEncoding).toLowerCase();
  if (normalizedEncoding === 'base64' || normalizedEncoding === 'quoted-printable') {
    const decoded = decodeTransferEncodedText(raw, options);
    return looksLikeReadableText(decoded) ? decoded : raw;
  }

  if (options.detectEncodedText === false) {
    return raw;
  }

  if (looksLikeQuotedPrintableText(raw)) {
    const decoded = decodeBytesWithCharset(decodeQuotedPrintableBytes(raw), options.contentType);
    if (looksLikeReadableText(decoded)) return decoded;
  }

  if (looksLikeBase64Text(raw)) {
    const bytes = decodeBase64Bytes(raw);
    if (bytes) {
      const decoded = decodeBytesWithCharset(bytes, options.contentType);
      if (looksLikeReadableText(decoded)) return decoded;
    }
  }

  return raw;
}

function extractMultipartBoundary(contentType) {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return trimString(match?.[1] || match?.[2]);
}

function splitMultipartBody(bodyText, boundary) {
  const normalizedBoundary = trimString(boundary);
  if (!normalizedBoundary) return [];

  const delimiter = `--${normalizedBoundary}`;
  const closingDelimiter = `${delimiter}--`;
  const lines = String(bodyText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const parts = [];
  let current = [];
  let collecting = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === delimiter || line === closingDelimiter) {
      if (collecting) {
        const joined = current.join('\n').trim();
        if (joined) parts.push(joined);
        current = [];
      }
      if (line === closingDelimiter) {
        break;
      }
      collecting = true;
      continue;
    }

    if (!collecting) {
      continue;
    }
    current.push(rawLine);
  }

  if (collecting && current.length) {
    const joined = current.join('\n').trim();
    if (joined) parts.push(joined);
  }

  return parts;
}

function collectMimeTextParts(bodyText, contentType, transferEncoding = '', depth = 0) {
  if (depth > MAX_MIME_NESTING_DEPTH) {
    return [];
  }

  const normalizedContentType = trimString(contentType) || 'text/plain; charset=UTF-8';

  if (/^multipart\//i.test(normalizedContentType)) {
    const boundary = extractMultipartBoundary(normalizedContentType);
    if (!boundary) {
      const decoded = decodeTransferEncodedText(bodyText, {
        contentType: normalizedContentType,
        transferEncoding,
      });
      const normalized = normalizeBodyPreview(decoded, normalizedContentType);
      return normalized ? [{ contentType: normalizedContentType, text: normalized }] : [];
    }

    const collected = [];
    for (const part of splitMultipartBody(bodyText, boundary)) {
      const { headerText, bodyText: partBody } = splitRawMessage(part);
      const partHeaders = parseHeaders(headerText);
      const partContentType = trimString(partHeaders['content-type']) || 'text/plain; charset=UTF-8';
      const partTransferEncoding = trimString(partHeaders['content-transfer-encoding']);
      const partDisposition = trimString(partHeaders['content-disposition']);

      if (/\battachment\b/i.test(partDisposition)) {
        continue;
      }

      if (/^message\/rfc822/i.test(partContentType)) {
        const decodedMessage = decodeTransferEncodedText(partBody, {
          contentType: partContentType,
          transferEncoding: partTransferEncoding,
        });
        const { headerText: nestedHeaderText, bodyText: nestedBodyText } = splitRawMessage(decodedMessage);
        const nestedHeaders = parseHeaders(nestedHeaderText);
        collected.push(...collectMimeTextParts(
          nestedBodyText,
          nestedHeaders['content-type'],
          nestedHeaders['content-transfer-encoding'],
          depth + 1,
        ));
        continue;
      }

      if (/^multipart\//i.test(partContentType)) {
        collected.push(...collectMimeTextParts(partBody, partContentType, partTransferEncoding, depth + 1));
        continue;
      }

      if (!/^text\//i.test(partContentType)) {
        continue;
      }

      const decodedPartBody = decodeTransferEncodedText(partBody, {
        contentType: partContentType,
        transferEncoding: partTransferEncoding,
      });
      const normalized = normalizeBodyPreview(decodedPartBody, partContentType);
      if (!normalized) {
        continue;
      }
      collected.push({
        contentType: partContentType,
        text: normalized,
      });
    }

    return collected;
  }

  if (/^message\/rfc822/i.test(normalizedContentType)) {
    const decodedMessage = decodeTransferEncodedText(bodyText, {
      contentType: normalizedContentType,
      transferEncoding,
    });
    const { headerText: nestedHeaderText, bodyText: nestedBodyText } = splitRawMessage(decodedMessage);
    const nestedHeaders = parseHeaders(nestedHeaderText);
    return collectMimeTextParts(
      nestedBodyText,
      nestedHeaders['content-type'],
      nestedHeaders['content-transfer-encoding'],
      depth + 1,
    );
  }

  const decoded = decodeTransferEncodedText(bodyText, {
    contentType: normalizedContentType,
    transferEncoding,
  });
  const normalized = normalizeBodyPreview(decoded, normalizedContentType);
  if (!normalized) {
    return [];
  }
  if (!/^text\//i.test(normalizedContentType) && !looksLikeReadableText(normalized)) {
    return [];
  }
  return [{
    contentType: normalizedContentType,
    text: normalized,
  }];
}

function extractBestEffortBodyText(bodyText, contentType, transferEncoding = '') {
  const normalizedParts = collectMimeTextParts(bodyText, contentType, transferEncoding);
  const plainText = normalizedParts.find((part) => /text\/plain/i.test(part.contentType));
  if (plainText?.text) return plainText.text;
  const htmlText = normalizedParts.find((part) => /text\/html/i.test(part.contentType));
  if (htmlText?.text) return htmlText.text;
  const firstText = normalizedParts.find((part) => part.text);
  if (firstText?.text) return firstText.text;
  const decoded = decodeTransferEncodedText(bodyText, { contentType, transferEncoding });
  return normalizeBodyPreview(decoded, contentType);
}

function normalizeBodyPreview(bodyText, contentType) {
  const content = String(bodyText || '');
  const maybeHtml = /text\/html/i.test(String(contentType || '')) || /<html|<body|<div|<p|<br/i.test(content);
  const normalized = maybeHtml ? stripHtml(content) : content;
  return normalized
    .replace(/=\r?\n/g, '')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

function trimTrailingBlankLines(lines) {
  const trimmedLines = [...lines];
  while (trimmedLines.length > 0 && !trimString(trimmedLines[trimmedLines.length - 1])) {
    trimmedLines.pop();
  }
  return trimmedLines;
}

function isReplyHeaderLine(line) {
  const normalized = trimString(line)
    .replace(/\u00a0/g, ' ')
    .replace(/[“”]/g, '"');
  if (!normalized) return false;
  return [
    /^On .+wrote:$/i,
    /^在.+写道[:：]?$/u,
    /^于.+写道[:：]?$/u,
    /^[- ]*Original Message[- ]*$/i,
    /^Begin forwarded message:$/i,
    /^[- ]*Forwarded message[- ]*$/i,
  ].some((pattern) => pattern.test(normalized));
}

function isHeaderLikeReplyLine(line) {
  const normalized = trimString(line);
  if (!normalized) return false;
  return [
    /^(From|To|Cc|Date|Sent|Subject):/i,
    /^(发件人|收件人|抄送|日期|发送时间|主题)[:：]/u,
  ].some((pattern) => pattern.test(normalized));
}

function looksLikeQuotedHeaderBlock(lines, startIndex) {
  let headerCount = 0;
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 6); index += 1) {
    const normalized = trimString(lines[index]);
    if (!normalized) {
      if (headerCount > 0) break;
      continue;
    }
    if (!isHeaderLikeReplyLine(normalized)) {
      break;
    }
    headerCount += 1;
  }
  return headerCount >= 2;
}

function looksLikeQuotedBlock(lines, startIndex) {
  const normalized = trimString(lines[startIndex]);
  if (!/^>+/.test(normalized)) return false;

  let quotedLineCount = 1;
  for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 5); index += 1) {
    const candidate = trimString(lines[index]);
    if (!candidate) continue;
    if (/^>+/.test(candidate)) {
      quotedLineCount += 1;
      continue;
    }
    break;
  }

  return quotedLineCount >= 2 || !trimString(lines[startIndex - 1] || '');
}

function stripUniformLeadingQuotePrefix(bodyText) {
  const lines = String(bodyText || '').replace(/\r/g, '\n').split('\n');
  const nonEmptyLines = lines.map((line) => trimString(line)).filter(Boolean);
  if (nonEmptyLines.length === 0) return trimString(bodyText);
  if (!nonEmptyLines.every((line) => /^>\s?/.test(line))) {
    return trimString(bodyText);
  }
  return lines.map((line) => line.replace(/^\s*>\s?/, '')).join('\n');
}

function extractLatestReplySegment(bodyText) {
  let candidate = trimString(bodyText);
  for (let pass = 0; pass < 3; pass += 1) {
    const unquoted = trimString(stripUniformLeadingQuotePrefix(candidate));
    if (!unquoted || unquoted === candidate) break;
    candidate = unquoted;
  }

  const original = candidate;
  if (!original) return '';

  const lines = original.replace(/\r/g, '\n').split('\n');
  const keptLines = [];
  let sawVisibleContent = false;

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index];
    const normalized = trimString(currentLine);

    if (sawVisibleContent) {
      if (isReplyHeaderLine(normalized) || looksLikeQuotedHeaderBlock(lines, index) || looksLikeQuotedBlock(lines, index)) {
        break;
      }
    }

    keptLines.push(currentLine);
    if (normalized) {
      sawVisibleContent = true;
    }
  }

  const compacted = trimString(trimTrailingBlankLines(keptLines).join('\n').replace(/\n{3,}/g, '\n\n'));
  return compacted || original;
}

function compactHeaders(headers) {
  const keys = ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'content-type', 'content-transfer-encoding'];
  return Object.fromEntries(keys.filter((key) => headers[key]).map((key) => [key, headers[key]]));
}

function extractHeaderMessageIds(value) {
  return [...new Set(String(value || '').match(/<[^>\r\n]+>/g) || [])];
}

function buildThreadReferencesHeader({ messageId = '', inReplyTo = '', references = '' } = {}) {
  const ids = [...extractHeaderMessageIds(references), ...extractHeaderMessageIds(inReplyTo)];
  const deduped = [...new Set(ids)];
  const normalizedMessageId = trimString(messageId);
  if (normalizedMessageId && !deduped.includes(normalizedMessageId)) {
    deduped.push(normalizedMessageId);
  }
  return deduped.join(' ').trim();
}

function deriveEmailThreadKey({ messageId = '', inReplyTo = '', references = '' } = {}) {
  const referenceIds = extractHeaderMessageIds(references);
  if (referenceIds.length) return referenceIds[0];

  const inReplyToIds = extractHeaderMessageIds(inReplyTo);
  if (inReplyToIds.length) return inReplyToIds[0];

  const messageIds = extractHeaderMessageIds(messageId);
  if (messageIds.length) return messageIds[0];

  return trimString(messageId) || trimString(inReplyTo) || trimString(references) || '';
}

function buildEmailThreadExternalTriggerId({ messageId = '', inReplyTo = '', references = '' } = {}) {
  const threadKey = deriveEmailThreadKey({ messageId, inReplyTo, references });
  return threadKey ? `email-thread:${encodeURIComponent(threadKey)}` : '';
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

function normalizeMessage({ rawMessage, sourcePath, identity, allowlist, automationSettings, extractedText = '', extractedHtml = '' }) {
  const { bodyText, headers, messageText, previewText } = extractNormalizedMailboxContent({
    rawMessage,
    extractedText,
    extractedHtml,
  });
  const senderAddress = extractPrimaryAddress(headers.from);
  const recipientAddress = extractPrimaryAddress(headers.to);
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
    subject: item.message.subject,
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
