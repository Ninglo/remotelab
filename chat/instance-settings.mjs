import { INSTANCE_SETTINGS_FILE } from '../lib/config.mjs';
import { dirname, join } from 'path';
import { createSerialTaskQueue, readJson, writeJsonAtomic } from './fs-utils.mjs';

const DEFAULT_VOICE_PROVIDER = 'doubao';
const VOICE_PROVIDER_GATEWAY_DIRECT = 'doubao_gateway_direct';
const DEFAULT_VOICE_RESOURCE_ID = 'volc.seedasr.sauc.duration';
const DEFAULT_VOICE_LANGUAGE = 'zh-CN';
const DEFAULT_GATEWAY_URL = 'wss://ai-gateway.vei.volces.com/v1/realtime';
const DEFAULT_GATEWAY_MODEL = 'bigmodel';
const DEFAULT_GATEWAY_AUTH_MODE = 'subprotocol';
const LEGACY_VOICE_INPUT_FILE = join(dirname(INSTANCE_SETTINGS_FILE), 'voice-input.json');
const writeInstanceSettings = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeVoiceInputSettings(rawValue = {}, { includeSecrets = true } = {}) {
  const value = rawValue && typeof rawValue === 'object'
    ? rawValue
    : {};
  const provider = trimString(value.provider) === VOICE_PROVIDER_GATEWAY_DIRECT
    ? VOICE_PROVIDER_GATEWAY_DIRECT
    : DEFAULT_VOICE_PROVIDER;
  const resourceId = trimString(value.resourceId || value.cluster) || DEFAULT_VOICE_RESOURCE_ID;
  const appId = trimString(value.appId || value.appid);
  const rawAccessToken = trimString(value.accessToken || value.token);
  const accessToken = includeSecrets
    ? rawAccessToken
    : '';
  const rawGatewayApiKey = trimString(value.gatewayApiKey || value.apiKey || value.gatewayAccessToken);
  const gatewayApiKey = includeSecrets
    ? rawGatewayApiKey
    : '';
  const gatewayUrl = trimString(value.gatewayUrl) || DEFAULT_GATEWAY_URL;
  const gatewayModel = trimString(value.gatewayModel || value.model) || DEFAULT_GATEWAY_MODEL;
  const gatewayAuthMode = trimString(value.gatewayAuthMode || value.authMode) || DEFAULT_GATEWAY_AUTH_MODE;
  const configured = value.configured === true || (
    provider === VOICE_PROVIDER_GATEWAY_DIRECT
      ? !!(rawGatewayApiKey && gatewayUrl && gatewayModel)
      : !!(appId && rawAccessToken && resourceId)
  );
  const clientReady = provider === VOICE_PROVIDER_GATEWAY_DIRECT
    ? configured && !!(gatewayApiKey && gatewayUrl && gatewayModel)
    : configured && !!resourceId;
  return {
    provider,
    appId,
    accessToken,
    resourceId,
    cluster: resourceId,
    gatewayApiKey,
    gatewayUrl,
    gatewayModel,
    gatewayAuthMode,
    language: trimString(value.language) || DEFAULT_VOICE_LANGUAGE,
    configured,
    clientReady,
    updatedAt: trimString(value.updatedAt),
  };
}

export function normalizeInstanceSettings(rawValue = {}, { includeSecrets = true } = {}) {
  const value = rawValue && typeof rawValue === 'object'
    ? rawValue
    : {};
  const voiceInput = normalizeVoiceInputSettings(value.voiceInput, { includeSecrets });
  return {
    version: 1,
    updatedAt: trimString(value.updatedAt) || voiceInput.updatedAt,
    voiceInput,
  };
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeLegacyVoiceInputSettings(rawValue = {}) {
  const value = rawValue && typeof rawValue === 'object'
    ? rawValue
    : {};
  if (value.enabled === false) {
    return null;
  }
  const volcengine = value.volcengine && typeof value.volcengine === 'object'
    ? value.volcengine
    : {};
  const legacyVoiceInput = normalizeVoiceInputSettings({
    appId: volcengine.appId || value.appId || value.appid,
    accessToken: volcengine.accessToken || volcengine.accessKey || value.accessToken || value.token,
    resourceId: volcengine.resourceId || volcengine.cluster || value.resourceId || value.cluster,
    language: volcengine.language || value.language,
    updatedAt: value.updatedAt,
  }, {
    includeSecrets: true,
  });
  return legacyVoiceInput.configured ? legacyVoiceInput : null;
}

async function loadRawInstanceSettings() {
  const stored = await readJson(INSTANCE_SETTINGS_FILE, null);
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    return normalizeInstanceSettings(stored, {
      includeSecrets: true,
    });
  }

  const legacyVoiceInput = normalizeLegacyVoiceInputSettings(
    await readJson(LEGACY_VOICE_INPUT_FILE, null),
  );
  if (legacyVoiceInput) {
    const migrated = normalizeInstanceSettings({
      version: 1,
      updatedAt: legacyVoiceInput.updatedAt || new Date().toISOString(),
      voiceInput: legacyVoiceInput,
    }, {
      includeSecrets: true,
    });
    await writeJsonAtomic(INSTANCE_SETTINGS_FILE, migrated);
    return migrated;
  }

  return normalizeInstanceSettings({}, {
    includeSecrets: true,
  });
}

export async function loadInstanceSettings({ includeSecrets = true } = {}) {
  const stored = await loadRawInstanceSettings();
  return normalizeInstanceSettings(stored, { includeSecrets });
}

export function buildClientInstanceSettings(settings, { authSession = null } = {}) {
  const includeSecrets = authSession?.role === 'owner';
  return normalizeInstanceSettings(settings, { includeSecrets });
}

export async function getBootstrapInstanceSettings(authSession = null) {
  const stored = await loadRawInstanceSettings();
  return buildClientInstanceSettings(stored, { authSession });
}

export async function updateInstanceSettings(rawPatch = {}) {
  const patch = rawPatch && typeof rawPatch === 'object'
    ? rawPatch
    : {};
  return writeInstanceSettings(async () => {
    const current = await loadRawInstanceSettings();
    const now = new Date().toISOString();
    const next = {
      version: 1,
      updatedAt: now,
      voiceInput: Object.prototype.hasOwnProperty.call(patch, 'voiceInput')
        ? normalizeVoiceInputSettings({
          ...current.voiceInput,
          ...(patch.voiceInput && typeof patch.voiceInput === 'object' ? patch.voiceInput : {}),
          updatedAt: now,
        }, {
          includeSecrets: true,
        })
        : current.voiceInput,
    };
    await writeJsonAtomic(INSTANCE_SETTINGS_FILE, next);
    return cloneValue(next);
  });
}

export async function loadServerVoiceInputSettings() {
  const settings = await loadRawInstanceSettings();
  return normalizeVoiceInputSettings(settings.voiceInput, { includeSecrets: true });
}
