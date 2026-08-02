import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

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
import { createLarkCliDocumentProvider } from './lark-cli-document-provider.mjs';

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

export async function readFeishuDocument(runtime, parameters = {}) {
  const documentToken = extractFeishuDocumentToken(parameters?.documentToken || parameters?.documentUrl);
  if (!documentToken) {
    throw createFeishuDocumentError(
      'document_token_invalid',
      'A valid Feishu Docx URL or document token is required.',
      400,
    );
  }
  const documentProvider = runtime?.documentProvider;
  if (!documentProvider?.fetch) {
    throw createFeishuDocumentError(
      'connector_unavailable',
      'The active Feishu connector does not provide the lark-cli document backend.',
      503,
    );
  }
  try {
    return await documentProvider.fetch({ ...parameters, documentToken: parameters.documentToken || documentToken });
  } catch (error) {
    throw normalizeFeishuDocumentError(error);
  }
}

export async function startFeishuDocumentCapability(runtime, options = {}) {
  const configDir = trimString(options?.configDir);
  if (!configDir) throw new Error('Feishu document capability requires an instance config directory');
  const storageDir = trimString(runtime?.config?.storageDir) || configDir;
  const sourceRouteId = trimString(runtime?.config?.sourceRouteId) || 'default';
  const documentProvider = options.documentProvider || createLarkCliDocumentProvider({
    appId: runtime?.config?.appId,
    appSecret: runtime?.config?.appSecret,
    brand: runtime?.config?.region === 'lark-global' ? 'lark' : 'feishu',
    sourceRouteId,
    configDir: trimString(options.larkCliConfigDir) || join(storageDir, 'lark-cli', sourceRouteId),
    snapshotDir: trimString(options.snapshotDir) || join(storageDir, 'document-snapshots', sourceRouteId),
    larkCliPath: options.larkCliPath,
    runCommand: options.runCommand,
  });
  await documentProvider.initialize();
  const capabilityRuntime = { ...runtime, documentProvider };
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
      return await readFeishuDocument(capabilityRuntime, body?.parameters || {});
    },
  });
  try {
    await initSkillRegistry(configDir);
    await registerConnectorSkills(FEISHU_CONNECTOR_ID, {
      sourceRouteId: runtime.config.sourceRouteId,
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
    documentProvider,
    async stop() {
      if (stopped) return;
      stopped = true;
      await initSkillRegistry(configDir);
      await deregisterConnectorSkills(FEISHU_CONNECTOR_ID, {
        sourceRouteId: runtime.config.sourceRouteId,
        skillUrl: server.skillUrl,
      });
      await server.stop();
    },
  };
}
