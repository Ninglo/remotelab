import { createDecipheriv } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DEFAULT_MAX_WECHAT_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value) {
  return trimString(value).replace(/\/+$/, '');
}

function normalizeIpAddress(value) {
  const normalized = trimString(value).toLowerCase().replace(/^\[|\]$/g, '');
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
}

export function isPrivateNetworkAddress(value) {
  const address = normalizeIpAddress(value);
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map((part) => Number.parseInt(part, 10));
    const [first, second] = octets;
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
  }
  if (version === 6) {
    return address === '::'
      || address === '::1'
      || address.startsWith('fc')
      || address.startsWith('fd')
      || /^fe[89ab]/.test(address)
      || address.startsWith('ff');
  }
  return false;
}

async function resolvePublicDownloadUrl(rawUrl, {
  allowPrivateNetwork = false,
  resolveHostname,
} = {}) {
  let url;
  try {
    url = new URL(trimString(rawUrl));
  } catch {
    throw new Error('WeChat image download URL is invalid');
  }
  if (url.username || url.password) {
    throw new Error('WeChat image download URL must not include credentials');
  }
  if (allowPrivateNetwork) {
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('WeChat image download URL must use HTTP or HTTPS');
    }
    return url;
  }
  if (url.protocol !== 'https:') {
    throw new Error('WeChat image download URL must use HTTPS');
  }

  const hostname = normalizeIpAddress(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('WeChat image download URL must use a public host');
  }
  const addresses = isIP(hostname)
    ? [hostname]
    : await resolveHostname(hostname);
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('WeChat image download host did not resolve');
  }
  if (addresses.some((address) => isPrivateNetworkAddress(address))) {
    throw new Error('WeChat image download URL resolved to a private network');
  }
  return url;
}

async function readBodyWithLimit(response, maxBytes) {
  const declaredLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isInteger(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`WeChat image exceeds ${maxBytes} bytes`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('WeChat image response did not expose a readable body');
  }

  const chunks = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`WeChat image exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
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
  const maxRedirects = Number.isInteger(options.maxRedirects) && options.maxRedirects >= 0
    ? options.maxRedirects
    : DEFAULT_MAX_REDIRECTS;
  const resolveHostname = typeof options.resolveHostname === 'function'
    ? options.resolveHostname
    : async (hostname) => (await lookup(hostname, { all: true, verbatim: true }))
      .map((entry) => trimString(entry?.address))
      .filter(Boolean);

  async function fetchDownload(runtime, rawUrl) {
    const allowPrivateNetwork = options.allowPrivateNetwork === true
      || runtime?.config?.wechatInboundResourceAllowPrivateNetwork === true;
    let currentUrl = await resolvePublicDownloadUrl(rawUrl, {
      allowPrivateNetwork,
      resolveHostname,
    });
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const response = await fetchImpl(currentUrl.href, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(downloadTimeoutMs),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = trimString(response.headers.get('location'));
      if (!location) throw new Error('WeChat image redirect did not include a location');
      if (redirectCount >= maxRedirects) {
        throw new Error(`WeChat image exceeded ${maxRedirects} redirects`);
      }
      currentUrl = await resolvePublicDownloadUrl(new URL(location, currentUrl).href, {
        allowPrivateNetwork,
        resolveHostname,
      });
    }
    throw new Error(`WeChat image exceeded ${maxRedirects} redirects`);
  }

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
    const response = await fetchDownload(runtime, downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download WeChat image (${response.status})`);
    }
    const encrypted = await readBodyWithLimit(response, maxBytes);
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
