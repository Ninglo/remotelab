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
  const useRawMimeReply = Boolean(inReplyTo || references || !subject);

  if (!sender) {
    return jsonResponse({ error: 'A sender address is required' }, 400);
  }
  if (mailboxFrom && sender.toLowerCase() !== mailboxFrom.toLowerCase()) {
    return jsonResponse({ error: `Sender must match ${mailboxFrom}` }, 400);
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
        const rawMime = buildPlainTextMime({
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

  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const response = await fetch(bridgeUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(trimString(env.MAILBOX_BRIDGE_TOKEN) ? { Authorization: `Bearer ${trimString(env.MAILBOX_BRIDGE_TOKEN)}` } : {}),
    },
    body: JSON.stringify({
      provider: 'cloudflare_email_worker',
      rawBase64: base64FromArrayBuffer(rawBuffer),
      envelope: {
        mailFrom: trimString(message.from),
        rcptTo: trimString(message.to),
      },
      headers: {
        subject: firstHeader(message.headers, 'subject'),
        messageId: firstHeader(message.headers, 'message-id'),
        references: buildThreadReferencesHeader({
          messageId: firstHeader(message.headers, 'message-id'),
          inReplyTo: firstHeader(message.headers, 'in-reply-to'),
          references: firstHeader(message.headers, 'references'),
        }),
        date: firstHeader(message.headers, 'date'),
      },
    }),
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
