import { createHash, randomBytes } from 'node:crypto';

import {
  deregisterConnectorSkills,
  initSkillRegistry,
  registerConnectorSkills,
} from '../../lib/connector-skill-registry.mjs';
import { startConnectorSkillServer } from '../../lib/connector-skill-server.mjs';
import definitionManifest from './manifest.json' with { type: 'json' };

export const definition = Object.freeze(definitionManifest);
export const WECHAT_CONNECTOR_ID = definition.id;
export const WECHAT_CONNECTOR_NAME = definition.name;
export const DEFAULT_WECHAT_SOURCE_ROUTE_ID = 'default';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createWeChatActionError(code, message, statusCode = 502, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function actionToSkill(action = {}) {
  const required = new Set(Array.isArray(action?.inputSchema?.required) ? action.inputSchema.required : []);
  const properties = action?.inputSchema?.properties && typeof action.inputSchema.properties === 'object'
    ? action.inputSchema.properties
    : {};
  return {
    name: trimString(action.id),
    description: trimString(action.description),
    schema: Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, {
      ...property,
      ...(required.has(name) ? { required: true } : {}),
    }])),
  };
}

export const WECHAT_SKILLS = Object.freeze(
  definition.actions.map(actionToSkill).filter((skill) => skill.name),
);

function opaqueId(prefix, value) {
  const digest = createHash('sha256').update(trimString(value) || prefix).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function normalizeWeChatDeliveryResult(delivery = {}) {
  const externalId = trimString(delivery.message_id || delivery.externalId);
  const accountId = trimString(delivery.accountId);
  const peerUserId = trimString(delivery.peerUserId);
  if (!externalId) {
    throw createWeChatActionError(
      'delivery_result_invalid',
      'WeChat accepted the action but did not return a delivery identifier.',
      502,
    );
  }
  return {
    connectorId: WECHAT_CONNECTOR_ID,
    bindingId: opaqueId('wechat_binding', accountId),
    targetId: opaqueId('wechat_target', `${accountId}:${peerUserId}`),
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId,
    message: 'WeChat text delivered.',
    retryable: false,
    requiresUserAction: false,
  };
}

export async function invokeWeChatSendText(parameters = {}, context = {}) {
  const text = trimString(parameters.text);
  const sessionId = trimString(parameters.sessionId);
  if (!text) {
    throw createWeChatActionError('text_required', 'WeChat send_text requires a non-empty text body.', 400);
  }
  if (typeof context.sendText !== 'function') {
    throw createWeChatActionError(
      'connector_unavailable',
      'The active WeChat connector does not provide text delivery.',
      503,
    );
  }
  try {
    return normalizeWeChatDeliveryResult(await context.sendText({ text, sessionId }));
  } catch (error) {
    if (error?.code && Number.isInteger(error?.statusCode)) throw error;
    const message = trimString(error?.message) || 'Failed to deliver WeChat text.';
    if (/no linked wechat account|binding|required|awaiting login/i.test(message)) {
      throw createWeChatActionError('binding_required', message, 409, { loginPath: '/connectors/wechat/login' });
    }
    if (/not bound to wechat|target|peer-user|user id/i.test(message)) {
      throw createWeChatActionError('target_required', message, 400);
    }
    throw createWeChatActionError('wechat_delivery_failed', message, 502);
  }
}

export async function clearWeChatCapabilityRegistration(configDir, options = {}) {
  const normalizedConfigDir = trimString(configDir);
  if (!normalizedConfigDir) return false;
  await initSkillRegistry(normalizedConfigDir);
  return await deregisterConnectorSkills(WECHAT_CONNECTOR_ID, {
    sourceRouteId: trimString(options.sourceRouteId) || DEFAULT_WECHAT_SOURCE_ROUTE_ID,
  });
}

export async function startWeChatSendTextCapability(runtime, options = {}) {
  const configDir = trimString(options.configDir);
  if (!configDir) throw new Error('WeChat send_text capability requires an instance config directory');
  const sourceRouteId = trimString(options.sourceRouteId) || DEFAULT_WECHAT_SOURCE_ROUTE_ID;
  const callbackToken = randomBytes(32).toString('hex');
  const skills = WECHAT_SKILLS.filter((skill) => skill.name === 'send_text');
  const server = await startConnectorSkillServer({
    channel: WECHAT_CONNECTOR_ID,
    token: callbackToken,
    skills,
    onSkill: async (skillName, body) => {
      if (skillName !== 'send_text') {
        throw createWeChatActionError('skill_not_found', `Unsupported WeChat action: ${skillName}`, 404);
      }
      return await invokeWeChatSendText(body?.parameters || {}, {
        sendText: options.sendText,
        runtime,
        call: body,
      });
    },
  });
  try {
    await initSkillRegistry(configDir);
    await registerConnectorSkills(WECHAT_CONNECTOR_ID, {
      sourceRouteId,
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
    sourceRouteId,
    async stop() {
      if (stopped) return;
      stopped = true;
      await initSkillRegistry(configDir);
      await deregisterConnectorSkills(WECHAT_CONNECTOR_ID, {
        sourceRouteId,
        skillUrl: server.skillUrl,
      });
      await server.stop();
    },
  };
}

export function createWeChatCapabilityController(runtime, options = {}) {
  const configDir = trimString(options.configDir);
  const sourceRouteId = trimString(options.sourceRouteId) || DEFAULT_WECHAT_SOURCE_ROUTE_ID;
  let capability = null;
  let lastReady = null;

  return {
    async reconcile(activeAccounts = []) {
      const ready = Array.isArray(activeAccounts) && activeAccounts.length > 0;
      if (ready && !capability) {
        capability = await startWeChatSendTextCapability(runtime, {
          configDir,
          sourceRouteId,
          sendText: options.sendText,
        });
        const changed = lastReady !== true;
        lastReady = true;
        return { changed, ready: true, skillUrl: capability.skillUrl };
      }
      if (!ready && capability) {
        await capability.stop();
        capability = null;
        const changed = lastReady !== false;
        lastReady = false;
        return { changed, ready: false, skillUrl: '' };
      }
      if (!ready && lastReady !== false) {
        await clearWeChatCapabilityRegistration(configDir, { sourceRouteId });
        lastReady = false;
        return { changed: true, ready: false, skillUrl: '' };
      }
      return { changed: false, ready, skillUrl: capability?.skillUrl || '' };
    },
    async stop() {
      if (!capability) return;
      await capability.stop();
      capability = null;
      lastReady = false;
    },
  };
}
