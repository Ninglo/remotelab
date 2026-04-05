import { EmailMessage } from 'cloudflare:email';

interface Env {
  EMAIL: SendEmail;
  MAILBOX_FROM: string;
  OUTBOUND_API_TOKEN?: string;
  MAILBOX_BRIDGE_URL?: string;
  MAILBOX_BRIDGE_TOKEN?: string;
}

interface OutboundSendPayload {
  to?: string | string[];
  from?: string;
  subject?: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: OutboundAttachmentPayload[];
}

interface OutboundAttachmentPayload {
  filename?: string;
  contentType?: string;
  contentBase64?: string;
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstHeader(headers: Headers, name: string): string {
  return trimString(headers.get(name) || '');
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeEmailAddress(value: unknown): string {
  return trimString(value).toLowerCase();
}

function splitEmailAddressParts(value: unknown): { localPart: string; domain: string } {
  const normalized = normalizeEmailAddress(value);
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1) {
    return {
      localPart: normalized,
      domain: '',
    };
  }
  return {
    localPart: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
  };
}

function senderAllowedForMailbox(sender: string, mailboxFrom: string): boolean {
  const normalizedSender = normalizeEmailAddress(sender);
  const normalizedMailboxFrom = normalizeEmailAddress(mailboxFrom);
  if (!normalizedMailboxFrom) {
    return !!normalizedSender;
  }
  if (normalizedSender === normalizedMailboxFrom) {
    return true;
  }
  const senderParts = splitEmailAddressParts(normalizedSender);
  const mailboxParts = splitEmailAddressParts(normalizedMailboxFrom);
  return !!senderParts.localPart && !!senderParts.domain && senderParts.domain === mailboxParts.domain;
}

function normalizeRecipients(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => trimString(entry)).filter(Boolean);
  }
  const single = trimString(value);
  return single ? [single] : [];
}

function extractHeaderMessageIds(value: unknown): string[] {
  return [...new Set(String(value || '').match(/<[^>\r\n]+>/g) || [])];
}

function buildThreadReferencesHeader({ messageId = '', inReplyTo = '', references = '' } = {}): string {
  const ids = [...extractHeaderMessageIds(references), ...extractHeaderMessageIds(inReplyTo)];
  const deduped = [...new Set(ids)];
  const normalizedMessageId = trimString(messageId);
  if (normalizedMessageId && !deduped.includes(normalizedMessageId)) {
    deduped.push(normalizedMessageId);
  }
  return deduped.join(' ').trim();
}

function headerValue(value: string): string {
  const normalized = trimString(value).replace(/\r?\n+/g, ' ').trim();
  return /[^\x20-\x7E]/.test(normalized)
    ? `=?UTF-8?B?${btoa(unescape(encodeURIComponent(normalized)))}?=`
    : normalized;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/(.{76})/g, '$1\r\n').trim();
}

function wrapBase64(value: string): string {
  return trimString(value).replace(/\s+/g, '').replace(/(.{76})/g, '$1\r\n').trim();
}

function quotedHeaderParam(value: string): string {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function base64FromArrayBuffer(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function messageIdDomain(fromAddress: string): string {
  const address = trimString(fromAddress);
  const atIndex = address.lastIndexOf('@');
  if (atIndex === -1) return 'workers.dev';
  const domain = address.slice(atIndex + 1).trim();
  return domain || 'workers.dev';
}

function buildGeneratedMessageId(fromAddress: string): string {
  return `<remotelab-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@${messageIdDomain(fromAddress)}>`;
}

function buildPlainTextMime({
  fromAddress,
  recipient,
  subject,
  text,
  inReplyTo,
  references,
  messageId,
}: {
  fromAddress: string;
  recipient: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  messageId: string;
}): string {
  const headers = [
    `From: ${fromAddress}`,
    `To: ${recipient}`,
    `Subject: ${headerValue(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  if (trimString(inReplyTo)) {
    headers.push(`In-Reply-To: ${trimString(inReplyTo)}`);
  }
  if (trimString(references)) {
    headers.push(`References: ${trimString(references)}`);
  } else if (trimString(inReplyTo)) {
    headers.push(`References: ${trimString(inReplyTo)}`);
  }
  return `${headers.join('\r\n')}\r\n\r\n${base64Utf8(text)}\r\n`;
}

function normalizeOutboundAttachments(value: OutboundAttachmentPayload[] | undefined): Array<{ filename: string; contentType: string; contentBase64: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      filename: trimString(entry?.filename) || 'attachment.bin',
      contentType: trimString(entry?.contentType) || 'application/octet-stream',
      contentBase64: wrapBase64(entry?.contentBase64 || ''),
    }))
    .filter((entry) => entry.contentBase64);
}

function buildMultipartMime({
  fromAddress,
  recipient,
  subject,
  text,
  inReplyTo,
  references,
  messageId,
  attachments,
}: {
  fromAddress: string;
  recipient: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  messageId: string;
  attachments: Array<{ filename: string; contentType: string; contentBase64: string }>;
}): string {
  const boundary = `remotelab-mixed-${crypto.randomUUID()}`;
  const headers = [
    `From: ${fromAddress}`,
    `To: ${recipient}`,
    `Subject: ${headerValue(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary=${quotedHeaderParam(boundary)}`,
  ];
  if (trimString(inReplyTo)) {
    headers.push(`In-Reply-To: ${trimString(inReplyTo)}`);
  }
  if (trimString(references)) {
    headers.push(`References: ${trimString(references)}`);
  } else if (trimString(inReplyTo)) {
    headers.push(`References: ${trimString(inReplyTo)}`);
  }

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Utf8(text),
  ];

  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name=${quotedHeaderParam(attachment.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename=${quotedHeaderParam(attachment.filename)}`,
      '',
      attachment.contentBase64,
    );
  }

  parts.push(`--${boundary}--`, '');
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n`;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

function authTokenFromRequest(request: Request): string {
  const header = trimString(request.headers.get('authorization') || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return trimString(match?.[1]);
}

async function handleOutboundSend(request: Request, env: Env): Promise<Response> {
  const configuredToken = trimString(env.OUTBOUND_API_TOKEN);
  if (!configuredToken) {
    return jsonResponse({ error: 'OUTBOUND_API_TOKEN is not configured' }, 503);
  }

  const providedToken = authTokenFromRequest(request);
  if (!providedToken || providedToken !== configuredToken) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let payload: OutboundSendPayload = {};
  try {
    payload = await request.json() as OutboundSendPayload;
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload' }, 400);
  }

  const sender = firstNonEmpty(payload.from, env.MAILBOX_FROM);
  const mailboxFrom = trimString(env.MAILBOX_FROM);
  const recipients = normalizeRecipients(payload.to);
  const subject = trimString(payload.subject);
  const text = trimString(payload.text);
  const inReplyTo = trimString(payload.inReplyTo);
  const references = trimString(payload.references) || inReplyTo;
  const attachments = normalizeOutboundAttachments(payload.attachments);
  const useRawMimeReply = Boolean(inReplyTo || references || !subject || attachments.length > 0);

  if (!sender) {
    return jsonResponse({ error: 'A sender address is required' }, 400);
  }
  if (mailboxFrom && !senderAllowedForMailbox(sender, mailboxFrom)) {
    return jsonResponse({ error: `Sender must match ${mailboxFrom} or use the same domain alias` }, 400);
  }
  if (recipients.length === 0) {
    return jsonResponse({ error: 'At least one recipient is required' }, 400);
  }
  if (!subject && !useRawMimeReply) {
    return jsonResponse({ error: 'A subject is required' }, 400);
  }
  if (!text) {
    return jsonResponse({ error: 'A text body is required' }, 400);
  }

  const generatedMessageId = buildGeneratedMessageId(sender);

  try {
    if (useRawMimeReply) {
      for (const recipient of recipients) {
        const rawMime = attachments.length > 0
          ? buildMultipartMime({
            fromAddress: sender,
            recipient,
            subject,
            text,
            inReplyTo,
            references,
            messageId: generatedMessageId,
            attachments,
          })
          : buildPlainTextMime({
            fromAddress: sender,
            recipient,
            subject,
            text,
            inReplyTo,
            references,
            messageId: generatedMessageId,
          });
        await env.EMAIL.send(new EmailMessage(sender, recipient, rawMime));
      }
    } else {
      await env.EMAIL.send({
        from: sender,
        to: recipients.length === 1 ? recipients[0] : recipients,
        subject,
        text,
      });
    }
  } catch (error) {
    const details = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };
    return jsonResponse({ error: 'Failed to send email', details }, 502);
  }

  return jsonResponse({
    id: generatedMessageId,
    message: 'sent',
    provider: 'cloudflare_send_email',
    from: sender,
    to: recipients,
  });
}

async function forwardInboundEmailToMailboxBridge(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const bridgeUrl = trimString(env.MAILBOX_BRIDGE_URL);
  if (!bridgeUrl) {
    throw new Error('MAILBOX_BRIDGE_URL is required');
  }

  // Stream the raw email directly instead of base64-encoding it in JSON.
  // This avoids ~3-4x memory amplification that caused exceededResources
  // errors on large emails with image attachments.
  const response = await fetch(bridgeUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'message/rfc822',
      'X-Envelope-From': trimString(message.from),
      'X-Envelope-To': trimString(message.to),
      'X-Email-Subject': firstHeader(message.headers, 'subject'),
      'X-Email-Message-Id': firstHeader(message.headers, 'message-id'),
      'X-Email-Date': firstHeader(message.headers, 'date'),
      'X-Email-In-Reply-To': firstHeader(message.headers, 'in-reply-to'),
      'X-Email-References': buildThreadReferencesHeader({
        messageId: firstHeader(message.headers, 'message-id'),
        inReplyTo: firstHeader(message.headers, 'in-reply-to'),
        references: firstHeader(message.headers, 'references'),
      }),
      ...(trimString(env.MAILBOX_BRIDGE_TOKEN) ? { Authorization: `Bearer ${trimString(env.MAILBOX_BRIDGE_TOKEN)}` } : {}),
    },
    body: message.raw,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mailbox bridge rejected inbound email (${response.status}): ${body || response.statusText}`);
  }
}

async function handleInboundEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  await forwardInboundEmailToMailboxBridge(message, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return jsonResponse({
        ok: true,
        service: 'remotelab-email-worker',
        from: trimString(env.MAILBOX_FROM),
        senderPolicy: 'exact_or_same_domain_alias',
        bridgeUrlConfigured: Boolean(trimString(env.MAILBOX_BRIDGE_URL)),
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/send-email') {
      return await handleOutboundSend(request, env);
    }
    return jsonResponse({ error: 'Not found' }, 404);
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleInboundEmail(message, env);
  },
};
