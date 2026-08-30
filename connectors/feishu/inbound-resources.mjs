import { Readable } from 'stream';

import { getSummaryFeishuResources } from './inbound-envelope.mjs';

const DEFAULT_MAX_FEISHU_RESOURCE_BYTES = 100 * 1024 * 1024;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeResourceIdPart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function normalizeBaseUrl(value) {
  return trimString(value).replace(/\/+$/, '');
}

function normalizeHeaderValue(headers, name) {
  if (!headers || !name) return '';
  if (typeof headers.get === 'function') {
    return trimString(headers.get(name));
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lowerName) {
      return Array.isArray(value) ? trimString(value[0]) : trimString(value);
    }
  }
  return '';
}

function normalizeContentType(value) {
  return trimString(value).split(';', 1)[0].toLowerCase();
}

function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return '';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return '';
}

function normalizeFeishuAttachmentMimeType(headers, buffer, fallbackType = 'image') {
  const headerMimeType = normalizeContentType(normalizeHeaderValue(headers, 'content-type'));
  if (headerMimeType && headerMimeType !== 'application/octet-stream') {
    return headerMimeType;
  }
  return detectImageMimeType(buffer)
    || (fallbackType === 'image' ? 'image/png' : (headerMimeType || 'application/octet-stream'));
}

function extensionForAttachmentMimeType(mimeType) {
  switch (normalizeContentType(mimeType)) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.bin';
  }
}

function parseContentDispositionFilename(value) {
  const header = trimString(value);
  if (!header) return '';
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return encoded[1];
    }
  }
  const quoted = header.match(/filename="([^"]+)"/i);
  if (quoted?.[1]) return quoted[1];
  const plain = header.match(/filename=([^;]+)/i);
  return plain?.[1] ? plain[1].trim() : '';
}

function sanitizeFeishuAttachmentOriginalName(value) {
  const normalized = trimString(value).replace(/\\/g, '/');
  return (normalized.split('/').filter(Boolean).pop() || '').replace(/\s+/g, ' ').slice(0, 255);
}

function buildFeishuAttachmentOriginalName(headers, fileKey, mimeType, index) {
  const fromHeader = sanitizeFeishuAttachmentOriginalName(
    parseContentDispositionFilename(normalizeHeaderValue(headers, 'content-disposition')),
  );
  if (fromHeader) return fromHeader;
  const safeKey = sanitizeResourceIdPart(fileKey).slice(0, 80) || `attachment_${index + 1}`;
  return `${safeKey}${extensionForAttachmentMimeType(mimeType)}`;
}

async function prepareBoundedFeishuResourceStream(readable, maxBytes) {
  if (!readable || typeof readable[Symbol.asyncIterator] !== 'function') {
    throw new Error('Feishu resource response is not a readable stream');
  }
  const iterator = readable[Symbol.asyncIterator]();
  const firstResult = await iterator.next();
  const firstBuffer = firstResult.done
    ? Buffer.alloc(0)
    : (Buffer.isBuffer(firstResult.value) ? firstResult.value : Buffer.from(firstResult.value));
  if (firstBuffer.length > maxBytes) {
    throw new Error(`Feishu resource exceeds ${maxBytes} bytes`);
  }
  let total = 0;

  async function* boundedChunks() {
    if (!firstResult.done) {
      total += firstBuffer.length;
      yield firstBuffer;
    }
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      const buffer = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
      total += buffer.length;
      if (total > maxBytes) {
        throw new Error(`Feishu resource exceeds ${maxBytes} bytes`);
      }
      yield buffer;
    }
  }

  return {
    body: Readable.from(boundedChunks()),
    previewBuffer: firstBuffer.subarray(0, 32),
    sizeBytes: () => total,
  };
}

export function createFeishuInboundResourceService(options = {}) {
  const requestRemoteLab = options.requestRemoteLab;
  const ensureAuthCookie = options.ensureAuthCookie;
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch;
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_FEISHU_RESOURCE_BYTES;

  async function publishRemoteLabAsset(runtime, {
    sessionId,
    body,
    originalName,
    mimeType,
    sizeBytes,
  }) {
    if (typeof runtime?.publishRemoteLabAsset === 'function') {
      return await runtime.publishRemoteLabAsset({
        sessionId,
        body,
        originalName,
        mimeType,
        sizeBytes,
      });
    }
    if (typeof requestRemoteLab !== 'function' || typeof ensureAuthCookie !== 'function') {
      throw new Error('RemoteLab asset publisher dependencies are unavailable');
    }

    const intentResult = await requestRemoteLab(runtime, '/api/assets/upload-intents', {
      method: 'POST',
      body: { sessionId, originalName, mimeType },
    });
    const intent = intentResult.json;
    if (!intentResult.response.ok || !intent?.asset?.id || !intent?.upload?.url) {
      throw new Error(intent?.error || intentResult.text || `Failed to create RemoteLab asset upload intent (${intentResult.response.status})`);
    }

    const chatBaseUrl = new URL(`${normalizeBaseUrl(runtime?.config?.chatBaseUrl)}/`);
    const uploadUrl = new URL(intent.upload.url, chatBaseUrl);
    const uploadHeaders = { ...(intent.upload.headers || {}) };
    if (uploadUrl.origin === chatBaseUrl.origin) {
      uploadHeaders.Cookie = await ensureAuthCookie(runtime, false);
    }
    const uploadResponse = await fetchImpl(uploadUrl, {
      method: intent.upload.method || 'PUT',
      headers: uploadHeaders,
      body,
      duplex: 'half',
      redirect: 'manual',
    });
    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload Feishu resource to RemoteLab asset ${intent.asset.id} (${uploadResponse.status})`);
    }

    const finalizeResult = await requestRemoteLab(runtime, `/api/assets/${encodeURIComponent(intent.asset.id)}/finalize`, {
      method: 'POST',
      body: {
        sizeBytes: sizeBytes(),
        etag: uploadResponse.headers.get('etag') || '',
      },
    });
    if (!finalizeResult.response.ok || !finalizeResult.json?.asset?.id) {
      throw new Error(finalizeResult.json?.error || finalizeResult.text || `Failed to finalize RemoteLab asset ${intent.asset.id}`);
    }
    return finalizeResult.json.asset;
  }

  async function download(runtime, {
    sessionId,
    messageId,
    fileKey,
    type = 'image',
    kind = 'image',
    originalName = '',
    index = 0,
  } = {}) {
    const normalizedSessionId = trimString(sessionId);
    const normalizedMessageId = trimString(messageId);
    const normalizedFileKey = trimString(fileKey);
    const normalizedType = trimString(type) || 'image';
    if (!normalizedSessionId || !normalizedMessageId || !normalizedFileKey) {
      throw new Error('RemoteLab session_id and Feishu resource message_id/file_key are required');
    }
    if (!runtime?.appClient?.im?.v1?.messageResource?.get) {
      throw new Error('Feishu message resource download API is unavailable');
    }
    const resource = await runtime.appClient.im.v1.messageResource.get({
      params: { type: normalizedType },
      path: {
        message_id: normalizedMessageId,
        file_key: normalizedFileKey,
      },
    });
    const prepared = await prepareBoundedFeishuResourceStream(resource.getReadableStream(), maxBytes);
    const mimeType = normalizeFeishuAttachmentMimeType(resource.headers, prepared.previewBuffer, normalizedType);
    const resolvedOriginalName = sanitizeFeishuAttachmentOriginalName(originalName)
      || buildFeishuAttachmentOriginalName(resource.headers, normalizedFileKey, mimeType, index);
    const asset = await publishRemoteLabAsset(runtime, {
      sessionId: normalizedSessionId,
      body: prepared.body,
      originalName: resolvedOriginalName,
      mimeType,
      sizeBytes: prepared.sizeBytes,
    });
    const assetId = trimString(asset?.id || asset?.assetId);
    if (!assetId) {
      throw new Error('RemoteLab asset publication returned no asset id');
    }
    return {
      assetId,
      mimeType: trimString(asset?.mimeType) || mimeType,
      originalName: trimString(asset?.originalName) || resolvedOriginalName,
      ...(Number.isInteger(asset?.sizeBytes) && asset.sizeBytes > 0
        ? { sizeBytes: asset.sizeBytes }
        : (prepared.sizeBytes() > 0 ? { sizeBytes: prepared.sizeBytes() } : {})),
      ...(kind !== 'image' ? { renderAs: 'file' } : {}),
    };
  }

  async function resolve(runtime, summary, { sessionId = '' } = {}) {
    const messageId = trimString(summary?.messageId);
    const resources = getSummaryFeishuResources(summary);
    const attachments = [];
    const failures = [];
    for (const [index, resource] of resources.entries()) {
      try {
        attachments.push(await download(runtime, {
          sessionId,
          messageId,
          fileKey: resource.fileKey,
          type: resource.resourceType,
          kind: resource.kind,
          originalName: resource.originalName,
          index,
        }));
      } catch (error) {
        failures.push({
          type: resource.resourceType,
          kind: resource.kind,
          fileKey: resource.fileKey,
          error: error?.message || String(error),
        });
        console.warn(`[feishu-connector] failed to ingest ${resource.kind} resource for ${messageId}: ${error?.message || error}`);
      }
    }
    return { attachments, failures };
  }

  return { download, resolve };
}
