const MAX_MIME_NESTING_DEPTH = 8;

function normalizeEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
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

function decodeRfc2047(value) {
  const raw = String(value || '');
  if (!raw.includes('=?')) return raw;

  // Collapse whitespace between adjacent encoded-words (RFC 2047 §6.2)
  const collapsed = raw.replace(/\?=\s+=\?/g, '?==?');

  return collapsed.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, text) => {
    try {
      const normalizedCharset = normalizeCharsetLabel(charset);
      if (encoding.toUpperCase() === 'B') {
        const bytes = Buffer.from(text, 'base64');
        return new TextDecoder(normalizedCharset).decode(bytes);
      }
      if (encoding.toUpperCase() === 'Q') {
        const withSpaces = text.replace(/_/g, ' ');
        const bytes = [];
        for (let i = 0; i < withSpaces.length; i += 1) {
          if (withSpaces[i] === '=' && /^[A-F0-9]{2}$/i.test(withSpaces.slice(i + 1, i + 3))) {
            bytes.push(parseInt(withSpaces.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            bytes.push(withSpaces.charCodeAt(i) & 0xFF);
          }
        }
        return new TextDecoder(normalizedCharset).decode(Uint8Array.from(bytes));
      }
    } catch {}
    return match;
  });
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

  for (const key of Object.keys(headers)) {
    headers[key] = decodeRfc2047(headers[key]);
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

function extractMimeType(contentType) {
  return trimString(String(contentType || '').split(';')[0]).toLowerCase();
}

function parseHeaderParameters(headerValue) {
  const parameters = {};
  const parts = String(headerValue || '').split(';').map((part) => part.trim()).filter(Boolean);
  for (const part of parts.slice(1)) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimString(part.slice(0, separatorIndex)).toLowerCase();
    const value = trimString(part.slice(separatorIndex + 1));
    if (!key) {
      continue;
    }
    parameters[key] = value;
  }
  return parameters;
}

function unwrapHeaderParameterValue(value) {
  const trimmed = trimString(value);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  return trimmed;
}

function decodeHeaderParameterValue(value, { extended = false } = {}) {
  const unwrapped = unwrapHeaderParameterValue(value);
  if (!extended) {
    return unwrapped;
  }

  const match = unwrapped.match(/^([^']*)'[^']*'(.*)$/);
  const encoded = match ? match[2] : unwrapped;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function extractHeaderParameter(headerValue, key) {
  const parameters = parseHeaderParameters(headerValue);
  const normalizedKey = trimString(key).toLowerCase();
  if (!normalizedKey) {
    return '';
  }
  if (parameters[`${normalizedKey}*`] !== undefined) {
    return decodeHeaderParameterValue(parameters[`${normalizedKey}*`], { extended: true });
  }
  if (parameters[normalizedKey] !== undefined) {
    return decodeHeaderParameterValue(parameters[normalizedKey]);
  }
  return '';
}

const IMAGE_EXTENSION_BY_MIME_TYPE = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/tiff': '.tif',
  'image/webp': '.webp',
};

function extensionForMimeType(mimeType) {
  const normalized = extractMimeType(mimeType);
  if (IMAGE_EXTENSION_BY_MIME_TYPE[normalized]) {
    return IMAGE_EXTENSION_BY_MIME_TYPE[normalized];
  }
  const subtype = normalized.split('/')[1] || 'bin';
  return `.${subtype.replace(/[^a-z0-9.+-]/gi, '').toLowerCase() || 'bin'}`;
}

function buildFallbackImageName(mimeType, index, disposition = '') {
  const prefix = disposition === 'inline' ? 'inline-image' : 'image';
  return `${prefix}-${index}${extensionForMimeType(mimeType)}`;
}

function buildFallbackAttachmentName(mimeType, index, disposition = '') {
  const prefix = disposition === 'inline' ? 'inline-attachment' : 'attachment';
  return `${prefix}-${index}${extensionForMimeType(mimeType)}`;
}

function normalizeContentId(value) {
  return trimString(value).replace(/^<|>$/g, '');
}

function decodeTransferEncodedBytes(text, { transferEncoding = '' } = {}) {
  const normalizedEncoding = trimString(transferEncoding).toLowerCase();
  if (normalizedEncoding === 'quoted-printable') {
    return decodeQuotedPrintableBytes(text);
  }
  if (normalizedEncoding === 'base64') {
    return decodeBase64Bytes(text) || new Uint8Array();
  }
  const raw = String(text || '');
  return raw ? Uint8Array.from(Buffer.from(raw, 'binary')) : new Uint8Array();
}

function buildMimeImagePart(bodyText, headers, state, options = {}) {
  const contentType = trimString(headers['content-type']) || 'application/octet-stream';
  const mimeType = extractMimeType(contentType);
  if (!/^image\//i.test(mimeType)) {
    return null;
  }

  const transferEncoding = trimString(headers['content-transfer-encoding']);
  const bytes = decodeTransferEncodedBytes(bodyText, { transferEncoding });
  if (!bytes.length) {
    return null;
  }

  state.counter += 1;
  const dispositionHeader = trimString(headers['content-disposition']);
  const disposition = trimString(dispositionHeader.split(';')[0]).toLowerCase();
  const contentId = normalizeContentId(headers['content-id']);
  const originalName = trimString(
    extractHeaderParameter(dispositionHeader, 'filename')
    || extractHeaderParameter(contentType, 'name')
    || buildFallbackImageName(mimeType, state.counter, disposition || (contentId ? 'inline' : 'attachment')),
  );

  const image = {
    mimeType,
    originalName,
    byteLength: bytes.length,
    disposition: disposition || (contentId ? 'inline' : 'attachment'),
  };
  if (contentId) {
    image.contentId = contentId;
  }
  if (options.includeData === true) {
    image.data = Buffer.from(bytes).toString('base64');
  }
  return image;
}

function buildMimeAttachmentPart(bodyText, headers, state, options = {}) {
  const contentType = trimString(headers['content-type']) || 'application/octet-stream';
  const mimeType = extractMimeType(contentType) || 'application/octet-stream';
  const dispositionHeader = trimString(headers['content-disposition']);
  const disposition = trimString(dispositionHeader.split(';')[0]).toLowerCase();
  const contentId = normalizeContentId(headers['content-id']);
  const namedAttachment = trimString(
    extractHeaderParameter(dispositionHeader, 'filename')
    || extractHeaderParameter(contentType, 'name'),
  );
  const isAttachmentDisposition = disposition === 'attachment';
  const isInlineAttachment = disposition === 'inline' && (contentId || namedAttachment);
  if (!isAttachmentDisposition && !isInlineAttachment) {
    return null;
  }

  const transferEncoding = trimString(headers['content-transfer-encoding']);
  const bytes = decodeTransferEncodedBytes(bodyText, { transferEncoding });
  if (!bytes.length) {
    return null;
  }

  state.counter += 1;
  const originalName = namedAttachment || buildFallbackAttachmentName(mimeType, state.counter, disposition);
  const attachment = {
    mimeType,
    originalName,
    byteLength: bytes.length,
    disposition: disposition || (contentId ? 'inline' : 'attachment'),
  };
  if (contentId) {
    attachment.contentId = contentId;
  }
  if (options.includeData === true) {
    attachment.data = Buffer.from(bytes).toString('base64');
  }
  return attachment;
}

function collectMimeParts(bodyText, headers = {}, options = {}, depth = 0, state = { counter: 0 }, mode = 'images') {
  if (depth > MAX_MIME_NESTING_DEPTH) {
    return [];
  }

  const contentType = trimString(headers['content-type']) || 'text/plain; charset=UTF-8';
  const transferEncoding = trimString(headers['content-transfer-encoding']);
  const mimeType = extractMimeType(contentType);

  if (/^multipart\//i.test(mimeType)) {
    const boundary = extractMultipartBoundary(contentType);
    if (!boundary) {
      return [];
    }

    const collected = [];
    for (const part of splitMultipartBody(bodyText, boundary)) {
      const { headerText, bodyText: partBody } = splitRawMessage(part);
      const partHeaders = parseHeaders(headerText);
      collected.push(...collectMimeParts(partBody, partHeaders, options, depth + 1, state, mode));
    }
    return collected;
  }

  if (/^message\/rfc822/i.test(mimeType)) {
    const decodedMessage = decodeTransferEncodedText(bodyText, {
      contentType,
      transferEncoding,
    });
    const { headerText: nestedHeaderText, bodyText: nestedBodyText } = splitRawMessage(decodedMessage);
    return collectMimeParts(nestedBodyText, parseHeaders(nestedHeaderText), options, depth + 1, state, mode);
  }

  const part = mode === 'attachments'
    ? buildMimeAttachmentPart(bodyText, headers, state, options)
    : buildMimeImagePart(bodyText, headers, state, options);
  return part ? [part] : [];
}

function extractRawMessageImages(rawMessage, options = {}) {
  const { headerText, bodyText } = splitRawMessage(String(rawMessage || ''));
  const headers = parseHeaders(headerText);
  return collectMimeParts(bodyText, headers, options, 0, { counter: 0 }, 'images');
}

function extractRawMessageAttachments(rawMessage, options = {}) {
  const { headerText, bodyText } = splitRawMessage(String(rawMessage || ''));
  const headers = parseHeaders(headerText);
  return collectMimeParts(bodyText, headers, options, 0, { counter: 0 }, 'attachments');
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

/**
 * Extract the raw HTML body from a MIME message without stripping tags.
 * Walks the MIME tree to find the first text/html part.
 * Returns the decoded HTML string, or '' if no HTML part exists.
 */
function extractMimeHtmlBody(bodyText, contentType, transferEncoding = '', depth = 0) {
  if (depth > MAX_MIME_NESTING_DEPTH) return '';

  const normalizedContentType = trimString(contentType) || 'text/plain; charset=UTF-8';

  if (/^multipart\//i.test(normalizedContentType)) {
    const boundary = extractMultipartBoundary(normalizedContentType);
    if (!boundary) return '';

    for (const part of splitMultipartBody(bodyText, boundary)) {
      const { headerText, bodyText: partBody } = splitRawMessage(part);
      const partHeaders = parseHeaders(headerText);
      const partContentType = trimString(partHeaders['content-type']) || 'text/plain; charset=UTF-8';
      const partTransferEncoding = trimString(partHeaders['content-transfer-encoding']);

      if (/\battachment\b/i.test(trimString(partHeaders['content-disposition']))) continue;

      if (/^multipart\//i.test(partContentType) || /^message\/rfc822/i.test(partContentType)) {
        const nested = partContentType.startsWith('message/') ? (() => {
          const decoded = decodeTransferEncodedText(partBody, { contentType: partContentType, transferEncoding: partTransferEncoding });
          const { headerText: nh, bodyText: nb } = splitRawMessage(decoded);
          const nHeaders = parseHeaders(nh);
          return extractMimeHtmlBody(nb, nHeaders['content-type'], nHeaders['content-transfer-encoding'], depth + 1);
        })() : extractMimeHtmlBody(partBody, partContentType, partTransferEncoding, depth + 1);
        if (nested) return nested;
        continue;
      }

      if (/^text\/html/i.test(partContentType)) {
        return decodeTransferEncodedText(partBody, {
          contentType: partContentType,
          transferEncoding: partTransferEncoding,
        });
      }
    }
    return '';
  }

  if (/^text\/html/i.test(normalizedContentType)) {
    return decodeTransferEncodedText(bodyText, {
      contentType: normalizedContentType,
      transferEncoding,
    });
  }

  return '';
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

function hasPlainTextMimePart(bodyText, contentType, transferEncoding = '') {
  const parts = collectMimeTextParts(bodyText, contentType, transferEncoding);
  return parts.some((part) => /text\/plain/i.test(part.contentType) && part.text);
}

function buildEmailThreadExternalTriggerId({ messageId = '', inReplyTo = '', references = '' } = {}) {
  const threadKey = deriveEmailThreadKey({ messageId, inReplyTo, references });
  return threadKey ? `email-thread:${encodeURIComponent(threadKey)}` : '';
}
export {
  buildEmailThreadExternalTriggerId,
  buildThreadReferencesHeader,
  compactHeaders,
  decodeMaybeEncodedMailboxText,
  decodeRfc2047,
  deriveEmailThreadKey,
  extractBestEffortBodyText,
  extractMimeHtmlBody,
  extractRawMessageAttachments,
  extractLatestReplySegment,
  extractPrimaryAddress,
  extractRawMessageImages,
  hasPlainTextMimePart,
  normalizeBodyPreview,
  parseHeaders,
  splitRawMessage,
};
