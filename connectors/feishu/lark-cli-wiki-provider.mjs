import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 50;
const DEFAULT_MAX_DEPTH = 4;
const MAX_DEPTH = 20;
const DEFAULT_MAX_NODES = 500;
const MAX_NODES = 5_000;
const DEFAULT_MAX_PAGES = 100;
const MAX_PAGES = 1_000;
const DEFAULT_MAX_INLINE_NODES = 200;
const MAX_INLINE_NODES = 1_000;
const VALID_OBJ_TYPES = new Set(['doc', 'docx', 'sheet', 'bitable', 'mindnote', 'slides', 'file']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function trimScalarString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function createWikiError(code, message, statusCode = 502, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizeInteger(value, name, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw createWikiError(
      'wiki_parameters_invalid',
      `${name} must be an integer between ${minimum} and ${maximum}.`,
      400,
    );
  }
  return parsed;
}

function normalizeSpaceId(value) {
  const spaceId = trimString(value);
  if (!spaceId) throw createWikiError('wiki_parameters_invalid', 'spaceId is required.', 400);
  if (spaceId === 'my_library') {
    throw createWikiError(
      'wiki_parameters_invalid',
      'my_library requires a user identity and is unavailable to the connector Bot identity.',
      400,
    );
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(spaceId)) {
    throw createWikiError('wiki_parameters_invalid', 'spaceId is invalid.', 400);
  }
  return spaceId;
}

function normalizeNodeReference(value, { required = true } = {}) {
  const reference = trimString(value);
  if (!reference && !required) return '';
  const rawToken = /^[A-Za-z0-9_-]{8,}$/.test(reference);
  const urlToken = /https?:\/\/[^\s)\]}>'"]+\/(?:wiki|doc|docx|sheet|base|bitable|mindnote|slides|file)\/[A-Za-z0-9_-]{8,}(?:[^\s)\]}>'"]*)?$/i.test(reference);
  if (!rawToken && !urlToken) {
    throw createWikiError(
      'wiki_node_token_invalid',
      'A valid Wiki node token, object token, or Feishu/Lark document URL is required.',
      400,
    );
  }
  return reference;
}

function normalizeNodeParameters(parameters = {}) {
  const nodeToken = normalizeNodeReference(parameters.nodeToken || parameters.token);
  const objType = trimString(parameters.objType).toLowerCase();
  if (objType && !VALID_OBJ_TYPES.has(objType)) {
    throw createWikiError(
      'wiki_parameters_invalid',
      `objType must be one of: ${[...VALID_OBJ_TYPES].join(', ')}.`,
      400,
    );
  }
  const isUrl = /^https?:\/\//i.test(nodeToken);
  const isWikiNode = /^wik/i.test(nodeToken) || /\/wiki\//i.test(nodeToken);
  if (objType && isWikiNode) {
    throw createWikiError('wiki_parameters_invalid', 'objType is not allowed for a Wiki node token.', 400);
  }
  if (!objType && !isUrl && !isWikiNode) {
    throw createWikiError('wiki_parameters_invalid', 'objType is required for a raw object token.', 400);
  }
  const spaceId = trimString(parameters.spaceId);
  return { nodeToken, objType, spaceId: spaceId ? normalizeSpaceId(spaceId) : '' };
}

function normalizeChildrenParameters(parameters = {}) {
  return {
    spaceId: normalizeSpaceId(parameters.spaceId),
    parentNodeToken: normalizeNodeReference(parameters.parentNodeToken, { required: false }),
    pageSize: normalizeInteger(parameters.pageSize, 'pageSize', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    pageToken: trimString(parameters.pageToken),
  };
}

function normalizeTreeParameters(parameters = {}) {
  const continuationToken = trimString(parameters.continuationToken);
  if (continuationToken && !/^[a-f0-9]{32}$/.test(continuationToken)) {
    throw createWikiError('wiki_continuation_invalid', 'continuationToken is invalid.', 400);
  }
  return {
    spaceId: normalizeSpaceId(parameters.spaceId),
    rootNodeToken: normalizeNodeReference(parameters.rootNodeToken, { required: false }),
    pageSize: normalizeInteger(parameters.pageSize, 'pageSize', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    maxDepth: normalizeInteger(parameters.maxDepth, 'maxDepth', DEFAULT_MAX_DEPTH, 0, MAX_DEPTH),
    maxNodes: normalizeInteger(parameters.maxNodes, 'maxNodes', DEFAULT_MAX_NODES, 1, MAX_NODES),
    maxPages: normalizeInteger(parameters.maxPages, 'maxPages', DEFAULT_MAX_PAGES, 1, MAX_PAGES),
    maxInlineNodes: normalizeInteger(
      parameters.maxInlineNodes,
      'maxInlineNodes',
      DEFAULT_MAX_INLINE_NODES,
      1,
      MAX_INLINE_NODES,
    ),
    continuationToken,
  };
}

function appendArg(args, name, value) {
  if (value === null || value === undefined || value === '') return;
  args.push(name, String(value));
}

function buildNodeGetArgs(parameters) {
  const args = [
    'wiki', '+node-get',
    '--node-token', parameters.nodeToken,
    '--as', 'bot',
    '--format', 'json',
  ];
  appendArg(args, '--obj-type', parameters.objType);
  appendArg(args, '--space-id', parameters.spaceId);
  return args;
}

function buildChildrenArgs(parameters) {
  const args = [
    'wiki', '+node-list',
    '--space-id', parameters.spaceId,
    '--page-size', String(parameters.pageSize),
    '--as', 'bot',
    '--format', 'json',
  ];
  appendArg(args, '--parent-node-token', parameters.parentNodeToken);
  appendArg(args, '--page-token', parameters.pageToken);
  return args;
}

function normalizeNode(value = {}) {
  return {
    spaceId: trimScalarString(value.space_id ?? value.spaceId),
    nodeToken: trimString(value.node_token ?? value.nodeToken),
    objToken: trimString(value.obj_token ?? value.objToken),
    objType: trimString(value.obj_type ?? value.objType),
    nodeType: trimString(value.node_type ?? value.nodeType),
    parentNodeToken: trimString(value.parent_node_token ?? value.parentNodeToken),
    title: trimString(value.title),
    hasChild: value.has_child === true || value.hasChild === true,
  };
}

function extractNode(payload) {
  const candidate = payload?.data?.node || payload?.data || payload?.node || payload;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw createWikiError('wiki_read_failed', 'lark-cli response did not include a Wiki node.', 502);
  }
  const node = normalizeNode(candidate);
  if (!node.nodeToken) {
    throw createWikiError('wiki_read_failed', 'lark-cli Wiki node response did not include node_token.', 502);
  }
  return node;
}

function extractChildren(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const rawNodes = Array.isArray(data?.nodes) ? data.nodes : (Array.isArray(data?.items) ? data.items : []);
  return {
    nodes: rawNodes.map(normalizeNode).filter((node) => node.nodeToken),
    hasMore: data?.has_more === true || data?.hasMore === true,
    nextPageToken: trimString(data?.page_token ?? data?.pageToken),
  };
}

export function createLarkCliWikiProvider(options = {}) {
  const sourceRouteId = trimString(options.sourceRouteId) || 'default';
  const snapshotDir = trimString(options.snapshotDir);
  const initialize = options.initialize;
  const runJson = options.runJson;
  if (!snapshotDir || typeof initialize !== 'function' || typeof runJson !== 'function') {
    throw createWikiError('connector_unavailable', 'The lark-cli Wiki provider is not configured.', 503);
  }

  async function getWikiNode(parameters = {}) {
    const normalized = normalizeNodeParameters(parameters);
    await initialize();
    return { identity: 'bot', node: extractNode(await runJson(buildNodeGetArgs(normalized))) };
  }

  async function listWikiChildren(parameters = {}) {
    const normalized = normalizeChildrenParameters(parameters);
    await initialize();
    const result = extractChildren(await runJson(buildChildrenArgs(normalized)));
    if (result.hasMore && !result.nextPageToken) {
      throw createWikiError(
        'wiki_read_failed',
        'lark-cli reported more Wiki children without a continuation page token.',
        502,
      );
    }
    return {
      identity: 'bot',
      spaceId: normalized.spaceId,
      parentNodeToken: normalized.parentNodeToken,
      pageSize: normalized.pageSize,
      ...result,
    };
  }

  function continuationPath(token) {
    return join(snapshotDir, 'wiki-tree-continuations', `${token}.json`);
  }

  async function loadContinuation(normalized) {
    if (!normalized.continuationToken) return null;
    const pathname = continuationPath(normalized.continuationToken);
    let state;
    try {
      state = JSON.parse(await readFile(pathname, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
        throw createWikiError(
          'wiki_continuation_invalid',
          'The Wiki traversal continuation token is missing or invalid.',
          400,
        );
      }
      throw error;
    }
    if (state?.version !== 1 || trimString(state.spaceId) !== normalized.spaceId || !Array.isArray(state.queue)) {
      throw createWikiError(
        'wiki_continuation_invalid',
        'The Wiki traversal continuation does not match this space.',
        400,
      );
    }
    if (normalized.rootNodeToken && trimString(state.rootNodeToken) !== normalized.rootNodeToken) {
      throw createWikiError(
        'wiki_continuation_invalid',
        'The Wiki traversal continuation does not match rootNodeToken.',
        400,
      );
    }
    return { pathname, state };
  }

  async function saveContinuation(normalized, queue) {
    if (queue.length === 0) return { can_resume: false, token: '', pending: 0 };
    await mkdir(join(snapshotDir, 'wiki-tree-continuations'), { recursive: true, mode: 0o700 });
    const token = randomBytes(16).toString('hex');
    await writeFile(continuationPath(token), `${JSON.stringify({
      version: 1,
      sourceRouteId,
      spaceId: normalized.spaceId,
      rootNodeToken: normalized.rootNodeToken,
      queue,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return {
      can_resume: true,
      token,
      pending: queue.length,
      next_depth: Math.min(...queue.map((entry) => entry.depth)),
    };
  }

  async function persistSnapshot(normalized, result, allNodes) {
    const snapshotId = createHash('sha256').update(JSON.stringify({
      sourceRouteId,
      spaceId: normalized.spaceId,
      rootNodeToken: normalized.rootNodeToken,
      nodes: allNodes,
      stop_reason: result.stop_reason,
      permission_failures: result.permission_failures,
      continuation: result.continuation,
    })).digest('hex').slice(0, 24);
    const directory = join(snapshotDir, 'wiki-tree', snapshotId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const contentPath = join(directory, 'tree.json');
    await writeFile(contentPath, `${JSON.stringify({
      identity: 'bot',
      sourceRouteId,
      spaceId: normalized.spaceId,
      rootNodeToken: normalized.rootNodeToken,
      complete: result.complete,
      truncated: result.truncated,
      stop_reason: result.stop_reason,
      visited: result.visited,
      returned: result.returned,
      failed: result.failed,
      pagesVisited: result.pagesVisited,
      permission_failures: result.permission_failures,
      continuation: result.continuation,
      nodes: allNodes,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return contentPath;
  }

  async function listWikiTree(parameters = {}) {
    const normalized = normalizeTreeParameters(parameters);
    await initialize();
    const resumed = await loadContinuation(normalized);
    const rootNodeToken = trimString(resumed?.state?.rootNodeToken) || normalized.rootNodeToken;
    const traversalParameters = { ...normalized, rootNodeToken };
    const queue = resumed
      ? resumed.state.queue.map((entry) => ({
        parentNodeToken: trimString(entry?.parentNodeToken),
        pageToken: trimString(entry?.pageToken),
        depth: Number(entry?.depth),
      })).filter((entry) => Number.isInteger(entry.depth) && entry.depth >= 0)
      : [{ parentNodeToken: rootNodeToken, pageToken: '', depth: 0 }];
    if (queue.length === 0) {
      throw createWikiError('wiki_continuation_invalid', 'The Wiki traversal continuation is empty.', 400);
    }

    const allNodes = [];
    const permissionFailures = [];
    const retryQueue = [];
    const deferredByDepth = [];
    let pagesVisited = 0;
    let visited = 0;
    let forcedStopReason = '';

    while (queue.length > 0) {
      if (pagesVisited >= normalized.maxPages) {
        forcedStopReason = 'max_pages';
        break;
      }
      if (allNodes.length >= normalized.maxNodes) {
        forcedStopReason = 'max_nodes';
        break;
      }
      const current = queue.shift();
      if (current.depth > normalized.maxDepth) {
        deferredByDepth.push(current, ...queue.splice(0));
        break;
      }

      pagesVisited += 1;
      let children;
      try {
        children = await listWikiChildren({
          spaceId: normalized.spaceId,
          parentNodeToken: current.parentNodeToken,
          pageToken: current.pageToken,
          pageSize: Math.min(normalized.pageSize, normalized.maxNodes - allNodes.length),
        });
      } catch (error) {
        if (error?.code !== 'missing_scope' && error?.code !== 'wiki_permission_denied') throw error;
        permissionFailures.push({
          parentNodeToken: current.parentNodeToken,
          depth: current.depth,
          code: error.code,
          message: trimString(error.message) || 'Wiki branch permission denied.',
          ...(trimString(error?.details?.consoleUrl) ? { consoleUrl: trimString(error.details.consoleUrl) } : {}),
        });
        retryQueue.push(current);
        continue;
      }

      visited += children.nodes.length;
      for (const child of children.nodes) {
        allNodes.push({ ...child, depth: current.depth });
        if (!child.hasChild) continue;
        const childBranch = { parentNodeToken: child.nodeToken, pageToken: '', depth: current.depth + 1 };
        if (childBranch.depth > normalized.maxDepth) deferredByDepth.push(childBranch);
        else queue.push(childBranch);
      }
      if (children.hasMore) queue.unshift({ ...current, pageToken: children.nextPageToken });
      if (allNodes.length >= normalized.maxNodes && (queue.length > 0 || deferredByDepth.length > 0)) {
        forcedStopReason = 'max_nodes';
        break;
      }
    }

    const pendingQueue = [...queue, ...deferredByDepth, ...retryQueue];
    let stopReason = 'completed';
    if (forcedStopReason) stopReason = forcedStopReason;
    else if (permissionFailures.length > 0) stopReason = 'permission_failures';
    else if (deferredByDepth.length > 0) stopReason = 'max_depth';
    const complete = stopReason === 'completed';
    const permissionFailureSummary = {
      count: permissionFailures.length,
      codes: [...new Set(permissionFailures.map((failure) => failure.code))],
      items: permissionFailures,
    };
    const continuation = await saveContinuation(traversalParameters, pendingQueue);
    const result = {
      identity: 'bot',
      spaceId: normalized.spaceId,
      rootNodeToken,
      complete,
      truncated: !complete,
      stop_reason: stopReason,
      visited,
      returned: allNodes.length,
      failed: permissionFailures.length,
      pagesVisited,
      permission_failures: permissionFailureSummary,
      continuation,
    };
    const contentPath = await persistSnapshot(traversalParameters, result, allNodes);
    if (resumed?.pathname) await rm(resumed.pathname, { force: true });
    return {
      ...result,
      nodes: allNodes.slice(0, normalized.maxInlineNodes),
      contentPath,
      contentLength: allNodes.length,
      inline_truncated: allNodes.length > normalized.maxInlineNodes,
    };
  }

  return { getWikiNode, listWikiChildren, listWikiTree };
}
