function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseMessageContent(rawContent) {
  const content = trimString(rawContent);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeFeishuResourceKind(value) {
  const normalized = trimString(value).toLowerCase();
  return ['image', 'file', 'audio', 'media'].includes(normalized) ? normalized : 'file';
}

function addFeishuResource(resources, resourceIndex, value) {
  const fileKey = trimString(value?.fileKey);
  const resourceType = trimString(value?.resourceType).toLowerCase() === 'image' ? 'image' : 'file';
  if (!fileKey) return;
  const dedupeKey = `${resourceType}:${fileKey}`;
  const originalName = trimString(value?.originalName);
  const existingIndex = resourceIndex.get(dedupeKey);
  if (Number.isInteger(existingIndex)) {
    if (originalName && !resources[existingIndex].originalName) {
      resources[existingIndex] = { ...resources[existingIndex], originalName };
    }
    return;
  }
  const kind = normalizeFeishuResourceKind(value?.kind);
  const downloadType = kind === 'image'
    ? 'image'
    : (['audio', 'media', 'file'].includes(kind) ? kind : resourceType);
  const resource = {
    fileKey,
    resourceType,
    kind,
    downloadType,
    ...(originalName ? { originalName } : {}),
  };
  resourceIndex.set(dedupeKey, resources.length);
  resources.push(resource);
}

function collectFeishuResources(value, resources, resourceIndex, messageType, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFeishuResources(item, resources, resourceIndex, messageType, depth + 1);
    }
    return;
  }
  if (typeof value !== 'object') return;

  const tag = trimString(value.tag).toLowerCase();
  const originalName = trimString(value.file_name || value.fileName);
  const fileKey = trimString(value.file_key || value.fileKey);
  if (fileKey && messageType !== 'sticker') {
    const isImage = messageType === 'image' || tag === 'img' || tag === 'image';
    const kind = isImage
      ? 'image'
      : (['audio', 'media', 'file'].includes(messageType)
        ? messageType
        : (['audio', 'media', 'file'].includes(tag) ? tag : 'file'));
    addFeishuResource(resources, resourceIndex, {
      fileKey,
      resourceType: isImage ? 'image' : 'file',
      kind,
      originalName,
    });
  }
  const imageKey = trimString(value.image_key || value.imageKey);
  if (imageKey) {
    addFeishuResource(resources, resourceIndex, {
      fileKey: imageKey,
      resourceType: 'image',
      kind: 'image',
    });
  }
  for (const child of Object.values(value)) {
    collectFeishuResources(child, resources, resourceIndex, messageType, depth + 1);
  }
}

export function extractFeishuResourcesFromContent(parsedContent, messageType = '') {
  const resources = [];
  collectFeishuResources(
    parsedContent,
    resources,
    new Map(),
    trimString(messageType).toLowerCase(),
  );
  return resources;
}

export function extractFeishuImageKeysFromContent(parsedContent, messageType = '') {
  return extractFeishuResourcesFromContent(parsedContent, messageType)
    .filter((resource) => resource.resourceType === 'image')
    .map((resource) => resource.fileKey);
}

export function getSummaryFeishuResources(summary) {
  const resources = [];
  const resourceIndex = new Map();
  for (const resource of Array.isArray(summary?.resources) ? summary.resources : []) {
    addFeishuResource(resources, resourceIndex, resource);
  }
  for (const imageKey of Array.isArray(summary?.imageKeys) ? summary.imageKeys : []) {
    addFeishuResource(resources, resourceIndex, {
      fileKey: imageKey,
      resourceType: 'image',
      kind: 'image',
    });
  }
  for (const resource of extractFeishuResourcesFromContent(
    parseMessageContent(summary?.rawContent),
    summary?.messageType,
  )) {
    addFeishuResource(resources, resourceIndex, resource);
  }
  return resources;
}

export function getSummaryFeishuImageKeys(summary) {
  return getSummaryFeishuResources(summary)
    .filter((resource) => resource.resourceType === 'image')
    .map((resource) => resource.fileKey);
}

const COMPLETE_FEISHU_MESSAGE_TYPES = new Set([
  '', 'text', 'image', 'file', 'audio', 'media', 'post', 'location',
]);

const PARTIAL_FEISHU_MESSAGE_TYPES = new Set([
  'interactive', 'share_chat', 'share_user', 'sticker',
]);

export function buildFeishuIngestionState(summary) {
  const messageType = trimString(summary?.messageType).toLowerCase();
  const resources = getSummaryFeishuResources(summary);
  const failures = Array.isArray(summary?.attachmentDownloadFailures)
    ? summary.attachmentDownloadFailures
    : [];
  let status = 'unparsed';
  if (failures.length > 0 || PARTIAL_FEISHU_MESSAGE_TYPES.has(messageType)) {
    status = 'partial';
  } else if (COMPLETE_FEISHU_MESSAGE_TYPES.has(messageType)) {
    status = 'complete';
  }
  return {
    status,
    resourceCount: resources.length,
    ...(failures.length > 0 ? { failedResourceCount: failures.length } : {}),
  };
}

export function buildFeishuSourceReference(summary) {
  const messageId = trimString(summary?.messageId);
  if (!messageId) return null;
  return {
    kind: 'feishu_message',
    messageId,
    messageType: trimString(summary?.messageType).toLowerCase() || 'unknown',
  };
}
