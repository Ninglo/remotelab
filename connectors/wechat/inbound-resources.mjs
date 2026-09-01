import { createDecipheriv } from 'node:crypto';

const DEFAULT_MAX_WECHAT_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value) {
  return trimString(value).replace(/\/+$/, '');
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

function extensionForMimeType(mimeType) {
  switch (mimeType) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    default: return '.bin';
  }
}

function parseAesKey(resource = {}) {
  const directKey = trimString(resource.aesKey);
  if (/^[a-f0-9]{32}$/i.test(directKey)) {
    return Buffer.from(directKey, 'hex');
  }

  const encodedKey = trimString(resource.encodedAesKey);
  if (encodedKey) {
    const decoded = Buffer.from(encodedKey, 'base64');
    const decodedText = decoded.toString('utf8').trim();
    if (/^[a-f0-9]{32}$/i.test(decodedText)) {
      return Buffer.from(decodedText, 'hex');
    }
    if (decoded.length === 16) return decoded;
  }
  throw new Error('WeChat image did not include a supported AES-128 key');
}

export function decryptWeChatImage(encrypted, resource = {}) {
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    throw new Error('WeChat image download was empty');
  }
  const decipher = createDecipheriv('aes-128-ecb', parseAesKey(resource), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function extractWeChatImageResources(itemList = []) {
  if (!Array.isArray(itemList)) return [];
  return itemList.flatMap((item, index) => {
    if (Number(item?.type) !== 2) return [];
    const image = item?.image_item;
    const media = image?.media;
    const downloadUrl = trimString(media?.full_url);
    const aesKey = trimString(image?.aeskey);
    const encodedAesKey = trimString(media?.aes_key);
    if (!downloadUrl || (!aesKey && !encodedAesKey)) return [];
    return [{
      kind: 'image',
      index,
      downloadUrl,
      aesKey,
      encodedAesKey,
      width: Number.isInteger(image?.thumb_width) ? image.thumb_width : 0,
      height: Number.isInteger(image?.thumb_height) ? image.thumb_height : 0,
      encryptedSizeBytes: Number.isInteger(image?.mid_size) ? image.mid_size : 0,
    }];
  });
}

export function createWeChatInboundResourceService(options = {}) {
  const requestRemoteLab = options.requestRemoteLab;
  const ensureAuthCookie = options.ensureAuthCookie;
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch;
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_WECHAT_IMAGE_BYTES;
  const downloadTimeoutMs = Number.isInteger(options.downloadTimeoutMs) && options.downloadTimeoutMs > 0
    ? options.downloadTimeoutMs
    : DEFAULT_DOWNLOAD_TIMEOUT_MS;

  async function publishRemoteLabAsset(runtime, { sessionId, body, originalName, mimeType }) {
    if (typeof runtime?.publishRemoteLabAsset === 'function') {
      return await runtime.publishRemoteLabAsset({
        sessionId,
        body,
        originalName,
        mimeType,
        sizeBytes: body.length,
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
      redirect: 'manual',
    });
    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload WeChat image to RemoteLab asset ${intent.asset.id} (${uploadResponse.status})`);
    }

    const finalizeResult = await requestRemoteLab(runtime, `/api/assets/${encodeURIComponent(intent.asset.id)}/finalize`, {
      method: 'POST',
      body: {
        sizeBytes: body.length,
        etag: uploadResponse.headers.get('etag') || '',
      },
    });
    if (!finalizeResult.response.ok || !finalizeResult.json?.asset?.id) {
      throw new Error(finalizeResult.json?.error || finalizeResult.text || `Failed to finalize RemoteLab asset ${intent.asset.id}`);
    }
    return finalizeResult.json.asset;
  }

  async function download(runtime, { sessionId, messageId, resource, index = 0 } = {}) {
    const downloadUrl = trimString(resource?.downloadUrl);
    if (!downloadUrl) throw new Error('WeChat image download URL is missing');
    const response = await fetchImpl(downloadUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(downloadTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Failed to download WeChat image (${response.status})`);
    }
    const declaredLength = Number.parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isInteger(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`WeChat image exceeds ${maxBytes} bytes`);
    }
    const encrypted = Buffer.from(await response.arrayBuffer());
    if (encrypted.length > maxBytes) {
      throw new Error(`WeChat image exceeds ${maxBytes} bytes`);
    }
    const body = decryptWeChatImage(encrypted, resource);
    const mimeType = detectImageMimeType(body);
    if (!mimeType) throw new Error('WeChat image decrypted to an unsupported format');
    const originalName = `wechat-${trimString(messageId) || 'message'}-${index + 1}${extensionForMimeType(mimeType)}`;
    const asset = await publishRemoteLabAsset(runtime, {
      sessionId,
      body,
      originalName,
      mimeType,
    });
    const assetId = trimString(asset?.id || asset?.assetId);
    if (!assetId) throw new Error('RemoteLab asset publication returned no asset id');
    return {
      assetId,
      mimeType: trimString(asset?.mimeType) || mimeType,
      originalName: trimString(asset?.originalName) || originalName,
      sizeBytes: Number.isInteger(asset?.sizeBytes) ? asset.sizeBytes : body.length,
    };
  }

  async function resolve(runtime, summary, { sessionId = '' } = {}) {
    const resources = Array.isArray(summary?.imageResources) ? summary.imageResources : [];
    const attachments = [];
    const failures = [];
    for (const [index, resource] of resources.entries()) {
      try {
        attachments.push(await download(runtime, {
          sessionId,
          messageId: summary?.messageId,
          resource,
          index,
        }));
      } catch (error) {
        failures.push({
          kind: 'image',
          index,
          error: error?.message || String(error),
        });
      }
    }
    return { attachments, failures };
  }

  return { download, resolve };
}
