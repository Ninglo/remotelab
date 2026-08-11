function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createFeishuWikiError(code, message, statusCode = 502, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizeFeishuWikiError(error) {
  if (error?.code && String(error.code).startsWith('wiki_')) return error;
  if (error?.code === 'missing_scope' || error?.code === 'connector_unavailable') return error;
  const responseData = error?.response?.data && typeof error.response.data === 'object'
    ? error.response.data
    : (error?.data && typeof error.data === 'object' ? error.data : {});
  const feishuCode = Number(responseData?.code ?? error?.feishuCode);
  const statusCode = Number(error?.response?.status ?? error?.statusCode ?? error?.status);
  const feishuMessage = trimString(responseData?.msg || responseData?.message || error?.message);
  const details = {
    ...(Number.isFinite(feishuCode) ? { feishuCode } : {}),
    ...(feishuMessage ? { feishuMessage } : {}),
  };
  if ([99991672, 99991679].includes(feishuCode) || /missing\s+scope|scope.*required/i.test(feishuMessage)) {
    return createFeishuWikiError(
      'missing_scope',
      'The Feishu app is missing the required Wiki node read scope.',
      403,
      details,
    );
  }
  if (feishuCode === 91403 || statusCode === 403) {
    return createFeishuWikiError(
      'wiki_permission_denied',
      'The Feishu bot app does not have permission to read this Wiki node.',
      403,
      details,
    );
  }
  if (statusCode === 404) {
    return createFeishuWikiError('wiki_node_not_found', 'The Feishu Wiki node was not found.', 404, details);
  }
  return createFeishuWikiError(
    'wiki_read_failed',
    feishuMessage || 'Failed to read the Feishu Wiki.',
    502,
    details,
  );
}

function getWikiProvider(runtime, methodName) {
  const provider = runtime?.wikiProvider || runtime?.documentProvider;
  if (typeof provider?.[methodName] !== 'function') {
    throw createFeishuWikiError(
      'connector_unavailable',
      'The active Feishu connector does not provide the lark-cli Wiki backend.',
      503,
    );
  }
  return provider;
}

function requireNodeReference(value) {
  const reference = trimString(value);
  if (!reference) {
    throw createFeishuWikiError(
      'wiki_node_token_invalid',
      'A Wiki node token, object token, or Feishu/Lark document URL is required.',
      400,
    );
  }
  return reference;
}

function requireSpaceId(value) {
  const spaceId = trimString(value);
  if (!spaceId) {
    throw createFeishuWikiError('wiki_parameters_invalid', 'spaceId is required.', 400);
  }
  return spaceId;
}

export async function getFeishuWikiNode(runtime, parameters = {}) {
  const normalized = { ...parameters, nodeToken: requireNodeReference(parameters.nodeToken || parameters.token) };
  const provider = getWikiProvider(runtime, 'getWikiNode');
  try {
    return await provider.getWikiNode(normalized);
  } catch (error) {
    throw normalizeFeishuWikiError(error);
  }
}

export async function listFeishuWikiChildren(runtime, parameters = {}) {
  const normalized = { ...parameters, spaceId: requireSpaceId(parameters.spaceId) };
  const provider = getWikiProvider(runtime, 'listWikiChildren');
  try {
    return await provider.listWikiChildren(normalized);
  } catch (error) {
    throw normalizeFeishuWikiError(error);
  }
}

export async function listFeishuWikiTree(runtime, parameters = {}) {
  const normalized = { ...parameters, spaceId: requireSpaceId(parameters.spaceId) };
  const provider = getWikiProvider(runtime, 'listWikiTree');
  try {
    return await provider.listWikiTree(normalized);
  } catch (error) {
    throw normalizeFeishuWikiError(error);
  }
}
