"use strict";

(function attachRemoteLabInstanceSettings(globalScope) {
  const DEFAULT_VOICE_PROVIDER = "doubao";
  const VOICE_PROVIDER_GATEWAY_DIRECT = "doubao_gateway_direct";
  const DEFAULT_VOICE_RESOURCE_ID = "volc.seedasr.sauc.duration";
  const DEFAULT_VOICE_LANGUAGE = "zh-CN";
  const DEFAULT_GATEWAY_URL = "wss://ai-gateway.vei.volces.com/v1/realtime";
  const DEFAULT_GATEWAY_MODEL = "bigmodel";
  const DEFAULT_GATEWAY_AUTH_MODE = "subprotocol";

  function trimString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function normalizeVoiceInputSettings(rawValue = {}) {
    const value = rawValue && typeof rawValue === "object"
      ? rawValue
      : {};
    const provider = trimString(value.provider) === VOICE_PROVIDER_GATEWAY_DIRECT
      ? VOICE_PROVIDER_GATEWAY_DIRECT
      : DEFAULT_VOICE_PROVIDER;
    const resourceId = trimString(value.resourceId || value.cluster) || DEFAULT_VOICE_RESOURCE_ID;
    const appId = trimString(value.appId || value.appid);
    const rawAccessToken = trimString(value.accessToken || value.token);
    const accessToken = rawAccessToken;
    const gatewayApiKey = trimString(value.gatewayApiKey || value.apiKey || value.gatewayAccessToken);
    const gatewayUrl = trimString(value.gatewayUrl) || DEFAULT_GATEWAY_URL;
    const gatewayModel = trimString(value.gatewayModel || value.model) || DEFAULT_GATEWAY_MODEL;
    const gatewayAuthMode = trimString(value.gatewayAuthMode || value.authMode) || DEFAULT_GATEWAY_AUTH_MODE;
    const configured = value.configured === true || (
      provider === VOICE_PROVIDER_GATEWAY_DIRECT
        ? !!(gatewayApiKey && gatewayUrl && gatewayModel)
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

  function normalizeInstanceSettings(rawValue = {}) {
    const value = rawValue && typeof rawValue === "object"
      ? rawValue
      : {};
    const voiceInput = normalizeVoiceInputSettings(value.voiceInput);
    return {
      version: 1,
      updatedAt: trimString(value.updatedAt) || voiceInput.updatedAt,
      voiceInput,
    };
  }

  function cloneSettings(settings) {
    return JSON.parse(JSON.stringify(settings));
  }

  function resolveInstanceSettingsUrl() {
    if (typeof withVisitorModeUrl === "function") {
      return withVisitorModeUrl("/api/settings");
    }
    if (typeof globalScope.remotelabResolveProductPath === "function") {
      return globalScope.remotelabResolveProductPath("/api/settings");
    }
    return "/api/settings";
  }

  function getBootstrapSettings() {
    return normalizeInstanceSettings(globalScope.__REMOTELAB_BOOTSTRAP__?.settings || {});
  }

  function canManageInstanceSettings() {
    return globalScope.__REMOTELAB_BOOTSTRAP__?.auth?.role === "owner";
  }

  let currentInstanceSettings = getBootstrapSettings();
  let pendingFetchPromise = null;
  let latestMutationId = 0;

  async function parseSettingsResponse(responsePromise) {
    const response = await responsePromise;
    if (response && typeof response === "object" && "ok" in response) {
      if (!response.ok) {
        let message = "Failed to load RemoteLab instance settings";
        try {
          const payload = await response.json();
          message = trimString(payload?.error) || message;
        } catch {}
        throw new Error(message);
      }
      return response.json();
    }
    return response;
  }

  function emitInstanceSettingsChange() {
    try {
      globalScope.dispatchEvent(new CustomEvent("remotelab:instancesettingschange", {
        detail: { settings: cloneSettings(currentInstanceSettings) },
      }));
    } catch {}
  }

  function setCurrentInstanceSettings(nextSettings, { emit = true } = {}) {
    currentInstanceSettings = normalizeInstanceSettings(nextSettings);
    if (emit) {
      emitInstanceSettingsChange();
    }
    return cloneSettings(currentInstanceSettings);
  }

  function mergeInstanceSettingsPatch(patch = {}) {
    const current = normalizeInstanceSettings(currentInstanceSettings);
    const nextPatch = patch && typeof patch === "object"
      ? patch
      : {};
    return normalizeInstanceSettings({
      ...current,
      ...nextPatch,
      voiceInput: {
        ...current.voiceInput,
        ...(nextPatch.voiceInput && typeof nextPatch.voiceInput === "object" ? nextPatch.voiceInput : {}),
      },
    });
  }

  async function fetchInstanceSettings({ force = false } = {}) {
    if (pendingFetchPromise && !force) {
      return pendingFetchPromise;
    }
    const runner = (async () => {
      const requestUrl = resolveInstanceSettingsUrl();
      const requestPromise = typeof fetchJsonOrRedirect === "function"
        ? fetchJsonOrRedirect(requestUrl, { revalidate: force !== true })
        : fetch(requestUrl);
      const payload = await parseSettingsResponse(requestPromise);
      return setCurrentInstanceSettings(payload?.settings || {});
    })();
    pendingFetchPromise = runner.finally(() => {
      if (pendingFetchPromise === runner) {
        pendingFetchPromise = null;
      }
    });
    return pendingFetchPromise;
  }

  async function updateInstanceSettings(patch = {}) {
    if (!canManageInstanceSettings()) {
      throw new Error("Owner access required");
    }
    const mutationId = latestMutationId + 1;
    latestMutationId = mutationId;
    const optimisticSettings = mergeInstanceSettingsPatch(patch);
    setCurrentInstanceSettings(optimisticSettings);
    try {
      const requestUrl = resolveInstanceSettingsUrl();
      const requestPromise = typeof fetchJsonOrRedirect === "function"
        ? fetchJsonOrRedirect(requestUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: patch }),
        })
        : fetch(requestUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: patch }),
        });
      const payload = await parseSettingsResponse(requestPromise);
      if (mutationId !== latestMutationId) {
        return cloneSettings(currentInstanceSettings);
      }
      return setCurrentInstanceSettings(payload?.settings || optimisticSettings);
    } catch (error) {
      try {
        await fetchInstanceSettings({ force: true });
      } catch {}
      throw error;
    }
  }

  globalScope.remotelabGetInstanceSettings = function remotelabGetInstanceSettings() {
    return cloneSettings(currentInstanceSettings);
  };
  globalScope.remotelabFetchInstanceSettings = fetchInstanceSettings;
  globalScope.remotelabUpdateInstanceSettings = updateInstanceSettings;
  globalScope.remotelabCanManageInstanceSettings = canManageInstanceSettings;
  globalScope.remotelabGetVoiceInputInstanceSettings = function remotelabGetVoiceInputInstanceSettings() {
    return normalizeVoiceInputSettings(currentInstanceSettings.voiceInput);
  };
})(window);
