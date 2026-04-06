import { randomBytes } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { CHAT_IMAGES_DIR, CHAT_SHARE_SNAPSHOTS_DIR } from '../lib/config.mjs';
import { createSerialTaskQueue, ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { materializeFileAssetAttachments } from './file-assets.mjs';

const runShareMutation = createSerialTaskQueue();
const SHARE_ID_PATTERN = /^snap_[a-f0-9]{48}$/;
const SHARE_ASSET_ID_PATTERN = /^asset_[a-f0-9]{24}$/;

async function ensureSharesDir() {
  await ensureDir(CHAT_SHARE_SNAPSHOTS_DIR);
}

function shareSnapshotPath(id) {
  return join(CHAT_SHARE_SNAPSHOTS_DIR, `${id}.json`);
}

function shareAssetsDir(id) {
  return join(CHAT_SHARE_SNAPSHOTS_DIR, `${id}.assets`);
}

function shareAssetPath(id, assetId) {
  return join(shareAssetsDir(id), assetId);
}

function generateShareId() {
  return `snap_${randomBytes(24).toString('hex')}`;
}

function generateShareAssetId() {
  return `asset_${randomBytes(12).toString('hex')}`;
}

function isValidShareId(id) {
  return typeof id === 'string' && SHARE_ID_PATTERN.test(id);
}

function isValidShareAssetId(id) {
  return typeof id === 'string' && SHARE_ASSET_ID_PATTERN.test(id);
}

function buildShareAssetUrl(shareId, assetId) {
  return `../share-asset/${shareId}/${assetId}`;
}

async function readAttachmentBuffer(image) {
  if (!image || typeof image !== 'object') return null;
  if (typeof image.data === 'string' && image.data) {
    const buffer = Buffer.from(image.data, 'base64');
    if (buffer.length > 0) return buffer;
  }

  if (typeof image.assetId === 'string' && image.assetId) {
    try {
      const materialized = (await materializeFileAssetAttachments([image]))[0];
      if (typeof materialized?.savedPath === 'string' && materialized.savedPath) {
        return await readFile(materialized.savedPath);
      }
    } catch {}
  }

  const filename = typeof image.filename === 'string' ? image.filename : null;
  const candidates = [];
  if (typeof image.savedPath === 'string' && image.savedPath) {
    candidates.push(image.savedPath);
  }
  if (filename) {
    candidates.push(join(CHAT_IMAGES_DIR, filename));
  }

  for (const filepath of candidates) {
    try {
      return await readFile(filepath);
    } catch {}
  }

  return null;
}

async function persistShareAttachment(shareId, image) {
  const buffer = await readAttachmentBuffer(image);
  if (!buffer || buffer.length === 0) return null;

  const assetId = generateShareAssetId();
  await ensureDir(shareAssetsDir(shareId));
  await writeFile(shareAssetPath(shareId, assetId), buffer);

  return {
    assetId,
    filename: typeof image?.filename === 'string' ? image.filename : undefined,
    originalName: typeof image?.originalName === 'string' ? image.originalName : undefined,
    mimeType: typeof image?.mimeType === 'string' && image.mimeType ? image.mimeType : 'application/octet-stream',
    url: buildShareAssetUrl(shareId, assetId),
  };
}

async function sanitizeAttachment(image, shareId) {
  if (shareId) {
    return persistShareAttachment(shareId, image);
  }

  const buffer = await readAttachmentBuffer(image);
  if (!buffer || buffer.length === 0) return null;
  return {
    filename: typeof image?.filename === 'string' ? image.filename : undefined,
    originalName: typeof image?.originalName === 'string' ? image.originalName : undefined,
    mimeType: typeof image?.mimeType === 'string' && image.mimeType ? image.mimeType : 'application/octet-stream',
    data: buffer.toString('base64'),
  };
}

async function sanitizeMessageEvent(event, shareId) {
  const snapshot = {
    type: 'message',
    id: event.id,
    timestamp: event.timestamp,
    role: event.role,
    content: typeof event.content === 'string' ? event.content : '',
  };
  if (Array.isArray(event.images) && event.images.length > 0) {
    const images = (await Promise.all(event.images.map((image) => sanitizeAttachment(image, shareId)))).filter(Boolean);
    if (images.length > 0) snapshot.images = images;
  }
  return snapshot;
}

async function sanitizeEvent(event, shareId) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null;

  switch (event.type) {
    case 'message':
      return sanitizeMessageEvent(event, shareId);
    case 'tool_use':
      return {
        type: 'tool_use',
        id: event.id,
        timestamp: event.timestamp,
        role: event.role,
        toolName: typeof event.toolName === 'string' ? event.toolName : '',
        toolInput: typeof event.toolInput === 'string' ? event.toolInput : '',
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        id: event.id,
        timestamp: event.timestamp,
        role: event.role,
        toolName: typeof event.toolName === 'string' ? event.toolName : '',
        output: typeof event.output === 'string' ? event.output : '',
        exitCode: Number.isInteger(event.exitCode) ? event.exitCode : undefined,
      };
    case 'file_change':
      return {
        type: 'file_change',
        id: event.id,
        timestamp: event.timestamp,
        role: event.role,
        filePath: typeof event.filePath === 'string' ? event.filePath : '',
        changeType: typeof event.changeType === 'string' ? event.changeType : '',
      };
    case 'reasoning':
    case 'status':
    case 'context_barrier':
      return {
        type: event.type,
        id: event.id,
        timestamp: event.timestamp,
        role: event.role,
        content: typeof event.content === 'string' ? event.content : '',
      };
    case 'context_operation':
      return {
        type: 'context_operation',
        id: event.id,
        timestamp: event.timestamp,
        role: event.role,
        content: typeof event.content === 'string' ? event.content : '',
        ...(typeof event.operation === 'string' && event.operation ? { operation: event.operation } : {}),
        ...(typeof event.phase === 'string' && event.phase ? { phase: event.phase } : {}),
        ...(typeof event.title === 'string' && event.title ? { title: event.title } : {}),
        ...(typeof event.summary === 'string' && event.summary ? { summary: event.summary } : {}),
        ...(typeof event.reason === 'string' && event.reason ? { reason: event.reason } : {}),
        ...(typeof event.trigger === 'string' && event.trigger ? { trigger: event.trigger } : {}),
        ...(Number.isInteger(event.compactedThroughSeq) ? { compactedThroughSeq: event.compactedThroughSeq } : {}),
      };
    case 'usage':
      {
      return {
        type: 'usage',
        id: event.id,
        timestamp: event.timestamp,
        role: event.role,
        ...(Number.isFinite(event.contextTokens) ? { contextTokens: event.contextTokens } : {}),
        inputTokens: Number.isFinite(event.inputTokens) ? event.inputTokens : 0,
        outputTokens: Number.isFinite(event.outputTokens) ? event.outputTokens : 0,
        ...(Number.isFinite(event.cachedInputTokens) ? { cachedInputTokens: event.cachedInputTokens } : {}),
        ...(Number.isFinite(event.reasoningTokens) ? { reasoningTokens: event.reasoningTokens } : {}),
        ...(Number.isFinite(event.contextWindowTokens)
          ? { contextWindowTokens: event.contextWindowTokens }
          : {}),
        ...(typeof event.contextSource === 'string' && event.contextSource
          ? { contextSource: event.contextSource }
          : {}),
        ...(Number.isFinite(event.costUsd) ? { costUsd: event.costUsd } : {}),
        ...(Number.isFinite(event.estimatedCostUsd) ? { estimatedCostUsd: event.estimatedCostUsd } : {}),
        ...(typeof event.estimatedCostModel === 'string' && event.estimatedCostModel
          ? { estimatedCostModel: event.estimatedCostModel }
          : {}),
        ...(typeof event.costSource === 'string' && event.costSource
          ? { costSource: event.costSource }
          : {}),
      };
      }
    default:
      return null;
  }
}

function sanitizeSession(session) {
  return {
    name: typeof session?.name === 'string' ? session.name : '',
    tool: typeof session?.tool === 'string' ? session.tool : '',
    created: typeof session?.created === 'string' ? session.created : null,
  };
}

export async function buildSanitizedSnapshot(session, history, extra = {}) {
  const createdAt = typeof extra.createdAt === 'string' && extra.createdAt
    ? extra.createdAt
    : new Date().toISOString();
  const shareId = typeof extra.id === 'string' && extra.id ? extra.id : null;
  const events = Array.isArray(history)
    ? (await Promise.all(history.map((event) => sanitizeEvent(event, shareId)))).filter(Boolean)
    : [];

  const snapshot = {
    version: 1,
    createdAt,
    session: sanitizeSession(session),
    events,
  };

  if (typeof extra.id === 'string' && extra.id) {
    snapshot.id = extra.id;
  }
  if (extra.view && typeof extra.view === 'object') {
    snapshot.view = extra.view;
  }

  return snapshot;
}

function snapshotNeedsAttachmentMigration(snapshot) {
  return Array.isArray(snapshot?.events) && snapshot.events.some((event) =>
    Array.isArray(event?.images) && event.images.some((image) =>
      image
      && typeof image === 'object'
      && (
        (typeof image.data === 'string' && image.data)
        || (typeof image.savedPath === 'string' && image.savedPath)
      ),
    ),
  );
}

async function migrateSnapshotAttachments(id, snapshot) {
  let changed = false;
  const events = await Promise.all((snapshot.events || []).map(async (event) => {
    if (!Array.isArray(event?.images) || event.images.length === 0) return event;

    let eventChanged = false;
    const nextImages = [];
    for (const image of event.images) {
      if (!image || typeof image !== 'object') continue;
      if (typeof image.url === 'string' && image.url && isValidShareAssetId(image.assetId)) {
        if ('data' in image || 'savedPath' in image) {
          const { data, savedPath, ...rest } = image;
          nextImages.push(rest);
          changed = true;
          eventChanged = true;
          continue;
        }
        nextImages.push(image);
        continue;
      }

      const externalized = await persistShareAttachment(id, image);
      if (externalized) {
        nextImages.push(externalized);
      }
      changed = true;
      eventChanged = true;
    }

    if (!eventChanged) return event;
    const nextEvent = { ...event };
    if (nextImages.length > 0) nextEvent.images = nextImages;
    else delete nextEvent.images;
    return nextEvent;
  }));

  if (!changed) return snapshot;
  const nextSnapshot = {
    ...snapshot,
    events,
  };
  await writeJsonAtomic(shareSnapshotPath(id), nextSnapshot);
  return nextSnapshot;
}

async function maybeMigrateShareSnapshot(id, snapshot) {
  if (!snapshotNeedsAttachmentMigration(snapshot)) return snapshot;
  return runShareMutation(async () => {
    const current = await readJson(shareSnapshotPath(id), null);
    if (!current || current.id !== id || !Array.isArray(current.events)) return null;
    if (!snapshotNeedsAttachmentMigration(current)) return current;
    return migrateSnapshotAttachments(id, current);
  });
}

export async function createShareSnapshot(session, history) {
  return runShareMutation(async () => {
    await ensureSharesDir();

    const id = generateShareId();
    const snapshot = await buildSanitizedSnapshot(session, history, {
      id,
      createdAt: new Date().toISOString(),
      view: {
        mode: 'share',
      },
    });

    await writeJsonAtomic(shareSnapshotPath(id), snapshot);
    return snapshot;
  });
}

export async function getShareSnapshot(id) {
  if (!isValidShareId(id)) return null;
  const snapshot = await readJson(shareSnapshotPath(id), null);
  if (!snapshot || snapshot.id !== id || !Array.isArray(snapshot.events)) return null;
  return maybeMigrateShareSnapshot(id, snapshot);
}

export async function getShareAsset(id, assetId) {
  if (!isValidShareId(id) || !isValidShareAssetId(assetId)) return null;
  const snapshot = await getShareSnapshot(id);
  if (!snapshot) return null;

  for (const event of snapshot.events) {
    for (const image of event?.images || []) {
      if (image?.assetId !== assetId) continue;
      return {
        filepath: shareAssetPath(id, assetId),
        mimeType: typeof image?.mimeType === 'string' && image.mimeType ? image.mimeType : 'application/octet-stream',
        filename: typeof image?.filename === 'string' ? image.filename : undefined,
        originalName: typeof image?.originalName === 'string' ? image.originalName : undefined,
      };
    }
  }

  return null;
}
