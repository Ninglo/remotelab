import {
  buildFeishuApiUuid,
  shouldReplyInFeishuThread,
} from './index.mjs';

export const MAX_FEISHU_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FEISHU_OUTBOUND_FILE_BYTES = 30 * 1024 * 1024;

const FEISHU_OUTBOUND_IMAGE_MIME_TYPES = new Set([
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveRemoteLabAttachmentDownloadPath(attachment) {
  const assetId = trimString(attachment?.assetId);
  if (assetId) {
    return `/api/assets/${encodeURIComponent(assetId)}/download?download=1`;
  }
  const downloadUrl = trimString(attachment?.downloadUrl);
  if (downloadUrl.startsWith('/api/assets/')) {
    return downloadUrl;
  }
  throw new Error('RemoteLab attachment is missing an asset download reference');
}

async function fetchRemoteLabAttachmentResponse(runtime, attachment, ensureAuthCookie, forceRefresh = false) {
  if (typeof ensureAuthCookie !== 'function') {
    throw new Error('Feishu attachment delivery requires RemoteLab authentication');
  }
  const downloadPath = resolveRemoteLabAttachmentDownloadPath(attachment);
  const cookie = await ensureAuthCookie(runtime, forceRefresh);
  const requestUrl = new URL(downloadPath, `${runtime.config.chatBaseUrl.replace(/\/+$/, '')}/`);
  let response = await fetch(requestUrl, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });

  if ([401, 403].includes(response.status) && !forceRefresh) {
    await response.body?.cancel?.().catch(() => {});
    return fetchRemoteLabAttachmentResponse(runtime, attachment, ensureAuthCookie, true);
  }

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = trimString(response.headers.get('location'));
    await response.body?.cancel?.().catch(() => {});
    if (!location) {
      throw new Error('RemoteLab attachment download redirect is missing a location');
    }
    response = await fetch(new URL(location, requestUrl), { redirect: 'follow' });
  }

  if (!response.ok || !response.body) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`Failed to download RemoteLab attachment (${response.status})`);
  }
  return response;
}

async function readResponseBufferWithLimit(response, maxBytes) {
  const declaredSize = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isInteger(declaredSize) && declaredSize > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`Attachment exceeds Feishu's ${Math.floor(maxBytes / (1024 * 1024))} MB file limit`);
  }

  const chunks = [];
  let sizeBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    sizeBytes += buffer.length;
    if (sizeBytes > maxBytes) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`Attachment exceeds Feishu's ${Math.floor(maxBytes / (1024 * 1024))} MB file limit`);
    }
    chunks.push(buffer);
  }
  if (sizeBytes === 0) {
    throw new Error('RemoteLab attachment is empty');
  }
  return Buffer.concat(chunks, sizeBytes);
}

export function resolveFeishuAttachmentFilename(attachment) {
  const raw = trimString(attachment?.originalName) || trimString(attachment?.filename) || 'attachment';
  const candidate = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'attachment';
  return candidate.slice(0, 255) || 'attachment';
}

export function resolveFeishuOutboundFileType(attachment) {
  const mimeType = trimString(attachment?.mimeType).toLowerCase();
  const filename = resolveFeishuAttachmentFilename(attachment).toLowerCase();
  if (mimeType === 'video/mp4' || filename.endsWith('.mp4')) return 'mp4';
  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) return 'pdf';
  if (mimeType === 'audio/opus' || filename.endsWith('.opus')) return 'opus';
  if (/wordprocessingml|msword/.test(mimeType) || /\.docx?$/.test(filename)) return 'doc';
  if (/spreadsheetml|ms-excel/.test(mimeType) || /\.xlsx?$/.test(filename)) return 'xls';
  if (/presentationml|ms-powerpoint/.test(mimeType) || /\.pptx?$/.test(filename)) return 'ppt';
  return 'stream';
}

export async function loadRemoteLabReplyAttachment(runtime, attachment, {
  ensureAuthCookie,
} = {}) {
  let buffer = null;
  if (Buffer.isBuffer(attachment?.buffer)) {
    buffer = attachment.buffer;
  } else if (typeof attachment?.data === 'string' && attachment.data) {
    buffer = Buffer.from(attachment.data, 'base64');
  } else {
    const statedSize = Number.parseInt(String(attachment?.sizeBytes || ''), 10);
    if (Number.isInteger(statedSize) && statedSize > MAX_FEISHU_OUTBOUND_FILE_BYTES) {
      throw new Error(`${resolveFeishuAttachmentFilename(attachment)} exceeds Feishu's 30 MB file limit`);
    }
    const response = await fetchRemoteLabAttachmentResponse(runtime, attachment, ensureAuthCookie);
    buffer = await readResponseBufferWithLimit(response, MAX_FEISHU_OUTBOUND_FILE_BYTES);
  }
  if (buffer.length === 0) {
    throw new Error(`${resolveFeishuAttachmentFilename(attachment)} is empty`);
  }
  if (buffer.length > MAX_FEISHU_OUTBOUND_FILE_BYTES) {
    throw new Error(`${resolveFeishuAttachmentFilename(attachment)} exceeds Feishu's 30 MB file limit`);
  }
  return {
    buffer,
    filename: resolveFeishuAttachmentFilename(attachment),
    mimeType: trimString(attachment?.mimeType).toLowerCase() || 'application/octet-stream',
  };
}

export async function sendFeishuAttachment(runtime, summary, attachment, uuid = '', {
  ensureAuthCookie,
} = {}) {
  const prepared = await loadRemoteLabReplyAttachment(runtime, attachment, { ensureAuthCookie });
  const useImageMessage = FEISHU_OUTBOUND_IMAGE_MIME_TYPES.has(prepared.mimeType)
    && prepared.buffer.length <= MAX_FEISHU_OUTBOUND_IMAGE_BYTES;
  let msgType;
  let content;

  if (useImageMessage) {
    const uploaded = await runtime.appClient.im.v1.image.create({
      data: {
        image_type: 'message',
        image: prepared.buffer,
      },
    });
    const imageKey = trimString(uploaded?.image_key || uploaded?.data?.image_key);
    if ((uploaded?.code !== undefined && uploaded.code !== 0) || !imageKey) {
      throw new Error(uploaded?.msg || `Failed to upload Feishu image ${prepared.filename}`);
    }
    msgType = 'image';
    content = JSON.stringify({ image_key: imageKey });
  } else {
    const uploaded = await runtime.appClient.im.v1.file.create({
      data: {
        file_type: resolveFeishuOutboundFileType({
          ...attachment,
          filename: prepared.filename,
          mimeType: prepared.mimeType,
        }),
        file_name: prepared.filename,
        file: prepared.buffer,
      },
    });
    const fileKey = trimString(uploaded?.file_key || uploaded?.data?.file_key);
    if ((uploaded?.code !== undefined && uploaded.code !== 0) || !fileKey) {
      throw new Error(uploaded?.msg || `Failed to upload Feishu file ${prepared.filename}`);
    }
    msgType = 'file';
    content = JSON.stringify({ file_key: fileKey });
  }

  const messageData = {
    msg_type: msgType,
    content,
    uuid: buildFeishuApiUuid(uuid, summary),
  };
  if (shouldReplyInFeishuThread(summary)) {
    const response = await runtime.appClient.im.v1.message.reply({
      path: {
        message_id: summary.messageId,
      },
      data: {
        ...messageData,
        reply_in_thread: true,
      },
    });
    if ((response.code !== undefined && response.code !== 0) || !response.data?.message_id) {
      throw new Error(response.msg || `Failed to send Feishu ${msgType} reply`);
    }
    return response.data;
  }

  const response = await runtime.appClient.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: summary.chatId,
      ...messageData,
    },
  });
  if ((response.code !== undefined && response.code !== 0) || !response.data?.message_id) {
    throw new Error(response.msg || `Failed to send Feishu ${msgType} message`);
  }
  return response.data;
}
