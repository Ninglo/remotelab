import { randomBytes } from 'node:crypto';

import {
  deregisterConnectorSkills,
  initSkillRegistry,
  registerConnectorSkills,
} from '../../lib/connector-skill-registry.mjs';
import { startConnectorSkillServer } from '../../lib/connector-skill-server.mjs';
import {
  FEISHU_CONNECTOR_ID,
  FEISHU_SKILLS,
  extractFeishuDocumentToken,
} from './index.mjs';

const DEFAULT_FEISHU_DOCUMENT_MAX_CHARS = 120_000;
const MAX_FEISHU_DOCUMENT_MAX_CHARS = 200_000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createFeishuDocumentError(code, message, statusCode = 502, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizeFeishuDocumentError(error) {
  if (error?.code && String(error.code).startsWith('document_')) return error;
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
    return createFeishuDocumentError(
      'missing_scope',
      'The Feishu app is missing the required document read scope.',
      403,
      details,
    );
  }
  if (feishuCode === 91403 || statusCode === 403) {
    return createFeishuDocumentError(
      'document_permission_denied',
      'The Feishu bot app does not have permission to read this document.',
      403,
      details,
    );
  }
  if (statusCode === 404) {
    return createFeishuDocumentError('document_not_found', 'The Feishu document was not found.', 404, details);
  }
  return createFeishuDocumentError(
    'document_read_failed',
    feishuMessage || 'Failed to read the Feishu document.',
    502,
    details,
  );
}

function ensureFeishuDocumentApiSuccess(response) {
  const code = Number(response?.code ?? 0);
  if (!Number.isFinite(code) || code === 0) return;
  const error = new Error(trimString(response?.msg) || `Feishu API returned code ${code}`);
  error.response = { status: code === 91403 ? 403 : 502, data: response };
  throw error;
}

function normalizeDocumentMaxChars(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FEISHU_DOCUMENT_MAX_CHARS;
  return Math.min(Math.floor(parsed), MAX_FEISHU_DOCUMENT_MAX_CHARS);
}

export async function readFeishuDocument(runtime, parameters = {}) {
  const documentToken = extractFeishuDocumentToken(parameters?.documentToken || parameters?.documentUrl);
  if (!documentToken) {
    throw createFeishuDocumentError(
      'document_token_invalid',
      'A valid Feishu Docx URL or document token is required.',
      400,
    );
  }
  const documentApi = runtime?.appClient?.docx?.v1?.document;
  if (!documentApi?.get || !documentApi?.rawContent) {
    throw createFeishuDocumentError(
      'connector_unavailable',
      'The active Feishu connector does not provide the Docx read API.',
      503,
    );
  }
  try {
    const [metadataResponse, contentResponse] = await Promise.all([
      documentApi.get({ path: { document_id: documentToken } }),
      documentApi.rawContent({ path: { document_id: documentToken } }),
    ]);
    ensureFeishuDocumentApiSuccess(metadataResponse);
    ensureFeishuDocumentApiSuccess(contentResponse);
    const metadata = metadataResponse?.data?.document || {};
    const content = typeof contentResponse?.data?.content === 'string'
      ? contentResponse.data.content
      : '';
    const maxChars = normalizeDocumentMaxChars(parameters?.maxChars);
    return {
      documentToken,
      title: trimString(metadata?.title),
      revisionId: Number.isFinite(Number(metadata?.revision_id)) ? Number(metadata.revision_id) : null,
      content: content.slice(0, maxChars),
      contentLength: content.length,
      truncated: content.length > maxChars,
      identity: 'bot',
    };
  } catch (error) {
    throw normalizeFeishuDocumentError(error);
  }
}

export async function startFeishuDocumentCapability(runtime, options = {}) {
  const configDir = trimString(options?.configDir);
  if (!configDir) throw new Error('Feishu document capability requires an instance config directory');
  const skills = FEISHU_SKILLS.filter((skill) => skill.name === 'document_get');
  const callbackToken = randomBytes(32).toString('hex');
  const server = await startConnectorSkillServer({
    channel: FEISHU_CONNECTOR_ID,
    token: callbackToken,
    skills,
    onSkill: async (skillName, body) => {
      if (skillName !== 'document_get') {
        throw createFeishuDocumentError('skill_not_found', `Unsupported Feishu skill: ${skillName}`, 404);
      }
      return await readFeishuDocument(runtime, body?.parameters || {});
    },
  });
  try {
    await initSkillRegistry(configDir);
    await registerConnectorSkills(FEISHU_CONNECTOR_ID, {
      callback: { skillUrl: server.skillUrl, token: callbackToken },
      skills,
    });
  } catch (error) {
    await server.stop();
    throw error;
  }
  let stopped = false;
  return {
    ...server,
    configDir,
    async stop() {
      if (stopped) return;
      stopped = true;
      await initSkillRegistry(configDir);
      await deregisterConnectorSkills(FEISHU_CONNECTOR_ID, { skillUrl: server.skillUrl });
      await server.stop();
    },
  };
}
