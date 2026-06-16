import { createHash } from 'crypto';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOrder(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}

function defaultBackoffMs(attempt) {
  return Math.min(250 * (2 ** Math.max(0, attempt - 1)), 2_000);
}

async function delay(ms) {
  if (!(Number.isFinite(ms) && ms > 0)) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((entry) => entry && typeof entry === 'object');
}

function normalizeError(error) {
  if (!error) return '';
  if (typeof error === 'string') return error.trim();
  return trimString(error.message || String(error));
}

export const CONNECTOR_DRIVER_EVENT_TYPES = Object.freeze({
  REDIRECT_DECIDED: 'redirect:decided',
  CONTENT_READY: 'content:ready',
  SUMMARY_READY: 'summary:ready',
  RESPONSE_FINALIZED: 'response:finalized',
});

export const OUTBOUND_CHAT_MESSAGE_KINDS = Object.freeze({
  REDIRECT_NOTICE: 'redirect_notice',
  CONTENT: 'content',
  SUMMARY: 'summary',
});

export function buildConnectorMessageId(idempotencyKey) {
  const digest = createHash('sha1').update(trimString(idempotencyKey)).digest('hex').slice(0, 16);
  return `msg_${digest}`;
}

export function buildConnectorIdempotencyKey({ responseId, order, kind, targetId = '' }) {
  const safeResponseId = trimString(responseId) || 'response';
  const safeKind = trimString(kind) || 'content';
  const safeTargetId = trimString(targetId) || 'default';
  return `${safeResponseId}:${safeTargetId}:${normalizeOrder(order)}:${safeKind}`;
}

export function buildOutboundChatMessage(input = {}) {
  const responseId = trimString(input.responseId);
  const kind = trimString(input.kind);
  if (!responseId) {
    throw new Error('OutboundChatMessage requires a responseId');
  }
  if (!kind) {
    throw new Error('OutboundChatMessage requires a kind');
  }
  const order = normalizeOrder(input.order);
  const idempotencyKey = trimString(input.idempotencyKey)
    || buildConnectorIdempotencyKey({
      responseId,
      order,
      kind,
      targetId: input.targetId,
    });
  return {
    messageId: trimString(input.messageId) || buildConnectorMessageId(idempotencyKey),
    responseId,
    kind,
    text: trimString(input.text),
    attachments: normalizeAttachments(input.attachments),
    link: trimString(input.link) || null,
    order,
    idempotencyKey,
  };
}

export function mapConnectorEventToOutboundMessage(event = {}, options = {}) {
  const type = trimString(event.type);
  const responseId = trimString(event.responseId || options.responseId);
  const targetId = trimString(event.targetId || options.targetId);
  const order = normalizeOrder(event.order, normalizeOrder(options.order));
  if (!responseId) {
    throw new Error('Connector event requires a responseId');
  }

  if (type === CONNECTOR_DRIVER_EVENT_TYPES.RESPONSE_FINALIZED) {
    return null;
  }

  if (type === CONNECTOR_DRIVER_EVENT_TYPES.REDIRECT_DECIDED) {
    return buildOutboundChatMessage({
      responseId,
      targetId,
      order,
      kind: OUTBOUND_CHAT_MESSAGE_KINDS.REDIRECT_NOTICE,
      text: trimString(event.text || event.message || 'This work has moved to another chat.'),
      link: trimString(event.link || event.openUrl),
      attachments: [],
    });
  }

  if (type === CONNECTOR_DRIVER_EVENT_TYPES.CONTENT_READY) {
    return buildOutboundChatMessage({
      responseId,
      targetId,
      order,
      kind: OUTBOUND_CHAT_MESSAGE_KINDS.CONTENT,
      text: trimString(event.text),
      link: trimString(event.link),
      attachments: event.attachments,
    });
  }

  if (type === CONNECTOR_DRIVER_EVENT_TYPES.SUMMARY_READY) {
    return buildOutboundChatMessage({
      responseId,
      targetId,
      order,
      kind: OUTBOUND_CHAT_MESSAGE_KINDS.SUMMARY,
      text: trimString(event.text),
      link: trimString(event.link),
      attachments: event.attachments,
    });
  }

  throw new Error(`Unsupported connector driver event type: ${type || 'unknown'}`);
}

export function renderOutboundChatMessageText(message = {}, options = {}) {
  const lines = [];
  const text = trimString(message.text);
  if (text) lines.push(text);

  const attachments = normalizeAttachments(message.attachments);
  if (options.includeAttachmentFallback === true && attachments.length > 0) {
    const attachmentLines = attachments
      .map((attachment) => trimString(attachment.filename || attachment.name))
      .filter(Boolean)
      .map((name) => `- ${name}`);
    if (attachmentLines.length > 0) {
      lines.push(`Attachments:\n${attachmentLines.join('\n')}`);
    }
  }

  const link = trimString(message.link);
  if (link) lines.push(link);
  return lines.join('\n\n').trim();
}

export function normalizeConnectorSendResult(result, error = null) {
  if (result && typeof result === 'object') {
    const state = trimString(result.state).toLowerCase();
    if (state === 'delivered') {
      return {
        state: 'delivered',
        externalId: trimString(result.externalId),
        retryable: false,
        lastError: '',
        metadata: result.metadata && typeof result.metadata === 'object' ? result.metadata : null,
      };
    }
    if (state === 'delivery_failed') {
      return {
        state: 'delivery_failed',
        externalId: trimString(result.externalId),
        retryable: result.retryable !== false,
        lastError: trimString(result.lastError) || normalizeError(error),
        metadata: result.metadata && typeof result.metadata === 'object' ? result.metadata : null,
      };
    }
  }

  return {
    state: 'delivery_failed',
    externalId: '',
    retryable: error?.retryable !== false,
    lastError: normalizeError(error),
    metadata: null,
  };
}

export class ConnectorDriver {
  #transport;
  #targetId;
  #maxAttempts;
  #backoffMs;
  #sleep;
  #now;
  #onRecord;
  #onAlert;
  #ledger;
  #queue;

  constructor({
    transport,
    targetId = '',
    maxAttempts = 3,
    backoffMs = defaultBackoffMs,
    sleep = delay,
    now = Date.now,
    onRecord = async () => {},
    onAlert = async () => {},
  } = {}) {
    if (!transport || typeof transport.send !== 'function') {
      throw new Error('ConnectorDriver requires a transport with a send(message) function');
    }
    this.#transport = transport;
    this.#targetId = trimString(targetId) || 'default';
    this.#maxAttempts = Math.max(1, Number.isInteger(maxAttempts) ? maxAttempts : 3);
    this.#backoffMs = typeof backoffMs === 'function' ? backoffMs : defaultBackoffMs;
    this.#sleep = typeof sleep === 'function' ? sleep : delay;
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#onRecord = typeof onRecord === 'function' ? onRecord : async () => {};
    this.#onAlert = typeof onAlert === 'function' ? onAlert : async () => {};
    this.#ledger = new Map();
    this.#queue = Promise.resolve();
  }

  getLedgerRecords() {
    return Array.from(this.#ledger.values()).map((record) => ({ ...record }));
  }

  async dispatchEvent(event, options = {}) {
    const message = mapConnectorEventToOutboundMessage(event, {
      ...options,
      targetId: trimString(options.targetId || event?.targetId) || this.#targetId,
    });
    if (!message) {
      return null;
    }
    return this.dispatchMessage(message);
  }

  async dispatchEvents(events = [], options = {}) {
    const results = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const result = await this.dispatchEvent(event, {
        ...options,
        order: normalizeOrder(event?.order, index),
      });
      if (result) {
        results.push(result);
      }
    }
    return results;
  }

  async dispatchMessage(message) {
    const outbound = buildOutboundChatMessage({
      ...message,
      targetId: this.#targetId,
    });
    const key = outbound.idempotencyKey;
    const existing = this.#ledger.get(key);
    if (existing?.state === 'delivered') {
      return {
        message: outbound,
        record: { ...existing },
        duplicate: true,
      };
    }

    const task = this.#queue.catch(() => null).then(() => this.#deliverMessage(outbound));
    this.#queue = task.catch(() => null);
    return task;
  }

  async #deliverMessage(message) {
    const key = message.idempotencyKey;
    let record = this.#touchRecord(message, {
      state: 'pending_send',
      attempts: this.#ledger.get(key)?.attempts || 0,
    });

    while (record.attempts < this.#maxAttempts) {
      const attempt = record.attempts + 1;
      record = this.#touchRecord(message, {
        state: 'sending',
        attempts: attempt,
        lastError: '',
      });

      let result;
      try {
        result = normalizeConnectorSendResult(await this.#transport.send(message));
      } catch (error) {
        result = normalizeConnectorSendResult(null, error);
      }

      if (result.state === 'delivered') {
        record = this.#touchRecord(message, {
          state: 'delivered',
          attempts: attempt,
          externalId: trimString(result.externalId),
          retryable: false,
          lastError: '',
          metadata: result.metadata,
          deliveredAt: nowIso(this.#now),
        });
        return { message, record };
      }

      const terminal = result.retryable !== true || attempt >= this.#maxAttempts;
      record = this.#touchRecord(message, {
        state: terminal ? 'delivery_failed' : 'retry_scheduled',
        attempts: attempt,
        externalId: trimString(result.externalId),
        retryable: result.retryable === true,
        lastError: trimString(result.lastError),
        metadata: result.metadata,
        failedAt: terminal ? nowIso(this.#now) : '',
      });

      if (terminal) {
        await this.#onAlert({ ...record }, message);
        return { message, record };
      }

      const backoffMs = Number(this.#backoffMs(attempt, message, result));
      await this.#sleep(Number.isFinite(backoffMs) ? backoffMs : 0);
    }

    return { message, record };
  }

  #touchRecord(message, patch = {}) {
    const key = message.idempotencyKey;
    const current = this.#ledger.get(key) || {
      messageId: message.messageId,
      responseId: message.responseId,
      kind: message.kind,
      order: message.order,
      idempotencyKey: key,
      targetId: this.#targetId,
      attempts: 0,
      state: 'pending_send',
      retryable: false,
      externalId: '',
      lastError: '',
      metadata: null,
      createdAt: nowIso(this.#now),
      deliveredAt: '',
      failedAt: '',
      updatedAt: nowIso(this.#now),
    };
    const next = {
      ...current,
      ...patch,
      updatedAt: nowIso(this.#now),
    };
    this.#ledger.set(key, next);
    void this.#onRecord({ ...next }, message);
    return next;
  }
}
