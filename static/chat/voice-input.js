"use strict";

(function attachRemoteLabVoiceInput(globalScope) {
  const DOUBAO_VOICE_WS_PATH = "/ws/voice-input/doubao";
  const VOICE_PROVIDER_GATEWAY_DIRECT = "doubao_gateway_direct";
  const VOICE_WORKLET_MODULE_PATH = "/chat/voice-input-worklet.js";
  const VOICE_WORKLET_PROCESSOR_NAME = "remotelab-voice-input-processor";
  const VOICE_SAMPLE_RATE = 16000;
  const VOICE_WORKLET_CHUNK_FRAMES = 2048;
  const VOICE_WORKLET_FLUSH_TIMEOUT_MS = 120;
  const VOICE_LEVEL_MULTIPLIER = 8;
  const MAX_BUFFERED_AUDIO_BYTES = VOICE_SAMPLE_RATE * 2 * 10;
  const DEFAULT_GATEWAY_URL = "wss://ai-gateway.vei.volces.com/v1/realtime";
  const DEFAULT_GATEWAY_MODEL = "bigmodel";
  const DEFAULT_GATEWAY_AUTH_MODE = "subprotocol";
  const GATEWAY_AUTH_SUBPROTOCOL_TEMPLATE = Object.freeze([
    "realtime",
    "openai-insecure-api-key.%API_KEY%",
    "openai-beta.realtime-v1",
  ]);
  const DEFAULT_CONFIG = Object.freeze({
    provider: "doubao",
    appId: "",
    accessToken: "",
    resourceId: "",
    cluster: "",
    gatewayApiKey: "",
    gatewayUrl: DEFAULT_GATEWAY_URL,
    gatewayModel: DEFAULT_GATEWAY_MODEL,
    gatewayAuthMode: DEFAULT_GATEWAY_AUTH_MODE,
    language: "zh-CN",
    configured: false,
    clientReady: false,
  });
  const activeVoiceCapture = {
    sessionId: "",
    phase: "idle",
    baseText: "",
    transcript: "",
    lastErrorMessage: "",
    mediaStream: null,
    audioContext: null,
    sourceNode: null,
    workletNode: null,
    processorNode: null,
    silenceNode: null,
    relaySocket: null,
    relayReady: false,
    stopRequested: false,
    stopSignalSent: false,
    voiceLevel: 0,
    eventCounter: 0,
    flushRequestId: 0,
    pendingFlushRequestId: 0,
    pendingFlushResolve: null,
    pendingFlushTimer: null,
    bufferedAudioFrames: [],
    bufferedAudioBytes: 0,
  };
  let voiceButtonFlashTimer = null;

  const voiceBtn = globalScope.document?.getElementById("voiceBtn") || null;

  function t(key, vars) {
    return globalScope.remotelabT ? globalScope.remotelabT(key, vars) : key;
  }

  function trimString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function toFiniteNumber(value) {
    return Number.isFinite(value) ? value : 0;
  }

  function clampNumber(value, min = 0, max = 1) {
    return Math.min(max, Math.max(min, toFiniteNumber(value)));
  }

  function isGatewayDirectVoiceProvider(providerOrConfig) {
    if (providerOrConfig && typeof providerOrConfig === "object") {
      return trimString(providerOrConfig.provider) === VOICE_PROVIDER_GATEWAY_DIRECT;
    }
    return trimString(providerOrConfig) === VOICE_PROVIDER_GATEWAY_DIRECT;
  }

  function summarizeVoiceConfig(config) {
    const resourceId = trimString(config?.resourceId || config?.cluster);
    const gatewayUrl = trimString(config?.gatewayUrl) || DEFAULT_GATEWAY_URL;
    let gatewayHost = "";
    try {
      gatewayHost = new URL(gatewayUrl, globalScope.location?.href || "https://remotelab.invalid").host;
    } catch {}
    return {
      provider: isGatewayDirectVoiceProvider(config) ? VOICE_PROVIDER_GATEWAY_DIRECT : "doubao",
      appIdSuffix: trimString(config?.appId).slice(-4) || "",
      resourceId,
      gatewayHost,
      gatewayModel: trimString(config?.gatewayModel) || DEFAULT_GATEWAY_MODEL,
      language: trimString(config?.language) || DEFAULT_CONFIG.language,
    };
  }

  function normalizeVoiceInputConfig(rawConfig) {
    const config = rawConfig && typeof rawConfig === "object"
      ? rawConfig
      : {};
    const provider = isGatewayDirectVoiceProvider(config.provider)
      ? VOICE_PROVIDER_GATEWAY_DIRECT
      : "doubao";
    const resourceId = trimString(config.resourceId || config.cluster);
    const appId = trimString(config.appId || config.appid);
    const rawAccessToken = trimString(config.accessToken || config.token);
    const gatewayApiKey = trimString(config.gatewayApiKey || config.apiKey || config.gatewayAccessToken);
    const gatewayUrl = trimString(config.gatewayUrl) || DEFAULT_GATEWAY_URL;
    const gatewayModel = trimString(config.gatewayModel || config.model) || DEFAULT_GATEWAY_MODEL;
    const gatewayAuthMode = trimString(config.gatewayAuthMode || config.authMode) || DEFAULT_GATEWAY_AUTH_MODE;
    const configured = config.configured === true || (
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
      accessToken: rawAccessToken,
      resourceId,
      cluster: resourceId,
      gatewayApiKey,
      gatewayUrl,
      gatewayModel,
      gatewayAuthMode,
      language: trimString(config.language) || DEFAULT_CONFIG.language,
      configured,
      clientReady,
    };
  }

  function readStoredVoiceInputConfig() {
    if (typeof globalScope.remotelabGetVoiceInputInstanceSettings === "function") {
      return normalizeVoiceInputConfig(globalScope.remotelabGetVoiceInputInstanceSettings());
    }
    return { ...DEFAULT_CONFIG };
  }

  async function writeStoredVoiceInputConfig(nextConfig) {
    const normalized = normalizeVoiceInputConfig(nextConfig);
    if (typeof globalScope.remotelabUpdateInstanceSettings === "function") {
      const settings = await globalScope.remotelabUpdateInstanceSettings({
        voiceInput: normalized,
      });
      const nextVoiceInput = normalizeVoiceInputConfig(settings?.voiceInput || normalized);
      refreshVoiceButtonUi();
      return nextVoiceInput;
    }
    refreshVoiceButtonUi();
    return normalized;
  }

  function reportVoiceInputRuntimeStatus(message, { hidden = false } = {}) {
    if (typeof globalScope.remotelabSetVoiceInputRuntimeStatus === "function") {
      globalScope.remotelabSetVoiceInputRuntimeStatus(message, { hidden });
    }
  }

  function getFriendlyVoiceErrorMessage(payload) {
    const code = trimString(payload?.code || payload?.error?.code);
    const rawMessage = trimString(payload?.message || payload?.error?.message);
    if (code === "30070102" || /api key invalid/i.test(rawMessage)) {
      return t("voice.error.invalidGatewayKey");
    }
    if (code === "45000030" || /requested resource not granted/i.test(rawMessage)) {
      return t("voice.error.resourceNotGranted");
    }
    if (code === "45000010" || /missing authorization header/i.test(rawMessage)) {
      return t("voice.error.missingAuthorization");
    }
    return rawMessage || t("voice.error.relayClosed");
  }

  function getVoiceInputLanguageOptions() {
    return [
      { value: "zh-CN", label: t("settings.voice.language.optionZhCN") },
      { value: "en-US", label: t("settings.voice.language.optionEnUS") },
    ];
  }

  function getVoiceInputClusterOptions() {
    return [
      {
        value: "volc.seedasr.sauc.duration",
        label: t("settings.voice.cluster.optionSeedDuration"),
      },
      {
        value: "volc.seedasr.sauc.concurrent",
        label: t("settings.voice.cluster.optionSeedConcurrent"),
      },
      {
        value: "volc.bigasr.sauc.duration",
        label: t("settings.voice.cluster.optionBigDuration"),
      },
      {
        value: "volc.bigasr.sauc.concurrent",
        label: t("settings.voice.cluster.optionBigConcurrent"),
      },
      {
        value: "__custom__",
        label: t("settings.voice.cluster.optionCustom"),
        isCustom: true,
      },
    ];
  }

  function getAudioContextConstructor() {
    return globalScope.AudioContext || globalScope.webkitAudioContext || null;
  }

  function hasAudioWorkletSupport() {
    return !!globalScope.AudioWorkletNode;
  }

  function getVoiceInputAssetVersion() {
    return trimString(globalScope.__REMOTELAB_BUILD__?.assetVersion) || "dev";
  }

  function resolveVoiceWorkletModulePath() {
    const versionedPath = `${VOICE_WORKLET_MODULE_PATH}?v=${encodeURIComponent(getVoiceInputAssetVersion())}`;
    if (typeof globalScope.remotelabResolveProductPath === "function") {
      return globalScope.remotelabResolveProductPath(versionedPath);
    }
    return versionedPath;
  }

  function syncVoiceButtonIcon() {
    if (!voiceBtn) return;
    const iconNode = voiceBtn.querySelector(".voice-btn-icon");
    if (!iconNode) return;
    const isActive = activeVoiceCapture.phase === "connecting"
      || activeVoiceCapture.phase === "recording"
      || activeVoiceCapture.phase === "stopping";
    const iconName = isActive ? "debug-stop" : "mic";
    if (iconNode.dataset.icon === iconName) return;
    iconNode.dataset.icon = iconName;
    if (globalScope.RemoteLabIcons?.render) {
      iconNode.innerHTML = globalScope.RemoteLabIcons.render(iconName);
      return;
    }
    if (globalScope.RemoteLabIcons?.hydrate) {
      globalScope.RemoteLabIcons.hydrate(iconNode);
    }
  }

  function setVoiceButtonLevel(level) {
    if (!voiceBtn) return;
    const normalizedLevel = clampNumber(level, 0, 1);
    activeVoiceCapture.voiceLevel = normalizedLevel;
    voiceBtn.style.setProperty("--voice-level", normalizedLevel.toFixed(3));
  }

  function smoothVoiceLevel(level) {
    const normalizedLevel = clampNumber(level, 0, 1);
    const currentLevel = clampNumber(activeVoiceCapture.voiceLevel, 0, 1);
    return normalizedLevel >= currentLevel
      ? normalizedLevel
      : (currentLevel * 0.72) + (normalizedLevel * 0.28);
  }

  function normalizeVoiceLevel(rms) {
    return clampNumber(toFiniteNumber(rms) * VOICE_LEVEL_MULTIPLIER, 0, 1);
  }

  function calculateAudioLevel(channelData) {
    if (!(channelData instanceof Float32Array) || channelData.length === 0) {
      return 0;
    }
    let sumSquares = 0;
    for (let index = 0; index < channelData.length; index += 1) {
      const sample = channelData[index];
      sumSquares += sample * sample;
    }
    return normalizeVoiceLevel(Math.sqrt(sumSquares / channelData.length));
  }

  function isLiveVoiceCapturePhase(phase = activeVoiceCapture.phase) {
    return phase === "connecting" || phase === "recording" || phase === "stopping";
  }

  function hasVoiceInputSupport() {
    return !!(
      voiceBtn
      && globalScope.WebSocket
      && globalScope.navigator?.mediaDevices?.getUserMedia
      && getAudioContextConstructor()
    );
  }

  function isVoiceInputConfigured(config = readStoredVoiceInputConfig()) {
    const normalizedConfig = normalizeVoiceInputConfig(config);
    return normalizedConfig?.clientReady === true;
  }

  function isVoiceInputOwnerOnly(config = readStoredVoiceInputConfig()) {
    const normalizedConfig = normalizeVoiceInputConfig(config);
    return isGatewayDirectVoiceProvider(normalizedConfig)
      && normalizedConfig?.configured === true
      && normalizedConfig?.clientReady !== true;
  }

  function getCurrentSessionSnapshot() {
    return typeof getCurrentSession === "function"
      ? getCurrentSession()
      : null;
  }

  function getVoiceButtonLabel() {
    switch (activeVoiceCapture.phase) {
      case "connecting":
        return t("voice.button.connecting");
      case "recording":
      case "stopping":
        return t("voice.button.stop");
      default: {
        const config = readStoredVoiceInputConfig();
        if (!hasVoiceInputSupport()) return t("voice.button.unsupported");
        if (isVoiceInputOwnerOnly(config)) return t("voice.button.ownerOnly");
        if (!isVoiceInputConfigured(config)) return t("voice.button.setup");
        return t("action.voiceInput");
      }
    }
  }

  function updateVoiceButtonText() {
    if (!voiceBtn) return;
    const labelNode = voiceBtn.querySelector(".img-btn-label");
    if (labelNode) {
      labelNode.textContent = getVoiceButtonLabel();
    }
  }

  function flashVoiceButtonText(text, durationMs = 2200) {
    if (!voiceBtn) return;
    const labelNode = voiceBtn.querySelector(".img-btn-label");
    if (!labelNode) return;
    if (voiceButtonFlashTimer) {
      globalScope.clearTimeout(voiceButtonFlashTimer);
      voiceButtonFlashTimer = null;
    }
    labelNode.textContent = text;
    voiceBtn.title = text;
    voiceBtn.setAttribute("aria-label", text);
    voiceButtonFlashTimer = globalScope.setTimeout(() => {
      voiceButtonFlashTimer = null;
      refreshVoiceButtonUi();
    }, durationMs);
  }

  function refreshVoiceButtonUi() {
    if (!voiceBtn) return;
    const config = readStoredVoiceInputConfig();
    const currentSession = getCurrentSessionSnapshot();
    const sessionId = typeof currentSessionId === "string" ? currentSessionId : "";
    const archived = currentSession?.archived === true;
    const shareSnapshotActive = typeof shareSnapshotMode !== "undefined" && shareSnapshotMode === true;
    const canStart = hasVoiceInputSupport()
      && isVoiceInputConfigured(config)
      && !!sessionId
      && !archived
      && !shareSnapshotActive;
    const isActive = isLiveVoiceCapturePhase();
    const showLiveCaptureState = !!activeVoiceCapture.audioContext
      && (activeVoiceCapture.phase === "connecting" || activeVoiceCapture.phase === "recording");

    voiceBtn.disabled = isActive ? false : !canStart;
    voiceBtn.classList.toggle("is-busy", activeVoiceCapture.phase === "connecting" || activeVoiceCapture.phase === "stopping");
    voiceBtn.classList.toggle("is-recording", showLiveCaptureState);
    if (!isActive) {
      setVoiceButtonLevel(0);
    }
    const buttonLabel = getVoiceButtonLabel();
    voiceBtn.title = buttonLabel;
    voiceBtn.setAttribute("aria-label", buttonLabel);
    syncVoiceButtonIcon();
    updateVoiceButtonText();
  }

  function resolveVoiceRelayUrl() {
    const proto = globalScope.location?.protocol === "https:" ? "wss:" : "ws:";
    const relativePath = typeof withVisitorModeUrl === "function"
      ? withVisitorModeUrl(DOUBAO_VOICE_WS_PATH)
      : DOUBAO_VOICE_WS_PATH;
    return `${proto}//${globalScope.location.host}${relativePath}`;
  }

  function resolveVoiceGatewayUrl(config) {
    const rawUrl = trimString(config?.gatewayUrl) || DEFAULT_GATEWAY_URL;
    const model = trimString(config?.gatewayModel) || DEFAULT_GATEWAY_MODEL;
    try {
      const url = new URL(rawUrl, globalScope.location?.href || undefined);
      if (!url.searchParams.get("model") && model) {
        url.searchParams.set("model", model);
      }
      return url.toString();
    } catch {
      if (!model || /(?:\?|&)model=/.test(rawUrl)) {
        return rawUrl;
      }
      return rawUrl.includes("?")
        ? `${rawUrl}&model=${encodeURIComponent(model)}`
        : `${rawUrl}?model=${encodeURIComponent(model)}`;
    }
  }

  function buildGatewayDirectAuthSubprotocols(apiKey) {
    return GATEWAY_AUTH_SUBPROTOCOL_TEMPLATE.map((entry) => entry.replace("%API_KEY%", apiKey));
  }

  function buildGatewayDirectSessionUpdatePayload(config) {
    const session = {
      input_audio_format: "pcm",
      input_audio_codec: "raw",
      input_audio_sample_rate: VOICE_SAMPLE_RATE,
      input_audio_bits: 16,
      input_audio_channel: 1,
      result_type: 0,
      turn_detection: null,
      input_audio_transcription: {
        model: trimString(config?.gatewayModel) || DEFAULT_GATEWAY_MODEL,
      },
    };
    const language = trimString(config?.language);
    if (language) {
      session.input_audio_transcription.language = language;
    }
    return {
      type: "transcription_session.update",
      session,
    };
  }

  function nextVoiceEventId(prefix = "voice") {
    activeVoiceCapture.eventCounter += 1;
    return `${prefix}_${Date.now()}_${activeVoiceCapture.eventCounter}`;
  }

  function joinComposerText(baseText, transcript) {
    const prefix = typeof baseText === "string" ? baseText : "";
    const suffix = trimString(transcript);
    if (!suffix) return prefix;
    if (!prefix) return suffix;
    return /\s$/.test(prefix) ? `${prefix}${suffix}` : `${prefix} ${suffix}`;
  }

  function dispatchComposerInputEvent() {
    if (!msgInput || typeof msgInput.dispatchEvent !== "function") return;
    if (typeof Event === "function") {
      msgInput.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (globalScope.document?.createEvent) {
      const event = globalScope.document.createEvent("Event");
      event.initEvent("input", true, true);
      msgInput.dispatchEvent(event);
    }
  }

  function applyTranscriptToComposer(transcript) {
    if (!msgInput) return;
    if (!activeVoiceCapture.sessionId || activeVoiceCapture.sessionId !== currentSessionId) {
      void stopVoiceCapture({ abandon: true });
      return;
    }
    activeVoiceCapture.transcript = trimString(transcript);
    msgInput.value = joinComposerText(activeVoiceCapture.baseText, activeVoiceCapture.transcript);
    dispatchComposerInputEvent();
  }

  function appendTranscriptFragmentToComposer(fragment) {
    const cleanFragment = trimString(fragment);
    if (!cleanFragment) return;
    applyTranscriptToComposer(`${activeVoiceCapture.transcript} ${cleanFragment}`.trim());
  }

  function downsampleTo16kHz(channelData, inputSampleRate) {
    if (!(channelData instanceof Float32Array)) {
      return new Float32Array(0);
    }
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0 || inputSampleRate === VOICE_SAMPLE_RATE) {
      return channelData;
    }
    if (inputSampleRate < VOICE_SAMPLE_RATE) {
      return channelData;
    }
    const sampleRateRatio = inputSampleRate / VOICE_SAMPLE_RATE;
    const newLength = Math.max(1, Math.round(channelData.length / sampleRateRatio));
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;
      for (let index = offsetBuffer; index < nextOffsetBuffer && index < channelData.length; index += 1) {
        accum += channelData[index];
        count += 1;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  function convertFloat32ToPcm16(channelData) {
    const pcmBytes = new ArrayBuffer(channelData.length * 2);
    const view = new DataView(pcmBytes);
    for (let index = 0; index < channelData.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return pcmBytes;
  }

  function bytesToBase64(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      return "";
    }
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const slice = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode.apply(null, slice);
    }
    return globalScope.btoa(binary);
  }

  function bufferAudioFrame(pcmBytes) {
    if (!(pcmBytes instanceof ArrayBuffer) || pcmBytes.byteLength === 0) {
      return;
    }
    activeVoiceCapture.bufferedAudioFrames.push(pcmBytes);
    activeVoiceCapture.bufferedAudioBytes += pcmBytes.byteLength;
    while (activeVoiceCapture.bufferedAudioBytes > MAX_BUFFERED_AUDIO_BYTES && activeVoiceCapture.bufferedAudioFrames.length > 0) {
      const droppedFrame = activeVoiceCapture.bufferedAudioFrames.shift();
      activeVoiceCapture.bufferedAudioBytes -= droppedFrame?.byteLength || 0;
    }
  }

  function flushBufferedAudioFrames() {
    const relaySocket = activeVoiceCapture.relaySocket;
    const config = readStoredVoiceInputConfig();
    if (
      !relaySocket
      || relaySocket.readyState !== WebSocket.OPEN
      || activeVoiceCapture.relayReady !== true
      || activeVoiceCapture.bufferedAudioFrames.length === 0
    ) {
      return;
    }
    while (activeVoiceCapture.bufferedAudioFrames.length > 0) {
      const frame = activeVoiceCapture.bufferedAudioFrames.shift();
      activeVoiceCapture.bufferedAudioBytes -= frame?.byteLength || 0;
      if (frame instanceof ArrayBuffer && frame.byteLength > 0) {
        if (isGatewayDirectVoiceProvider(config)) {
          relaySocket.send(JSON.stringify({
            event_id: nextVoiceEventId("audio"),
            type: "input_audio_buffer.append",
            audio: bytesToBase64(new Uint8Array(frame)),
          }));
        } else {
          relaySocket.send(frame);
        }
      }
    }
    activeVoiceCapture.bufferedAudioBytes = 0;
  }

  function sendVoiceTransportStopSignal() {
    const relaySocket = activeVoiceCapture.relaySocket;
    const config = readStoredVoiceInputConfig();
    if (
      activeVoiceCapture.stopSignalSent
      || !relaySocket
      || relaySocket.readyState !== WebSocket.OPEN
      || activeVoiceCapture.relayReady !== true
    ) {
      return;
    }
    flushBufferedAudioFrames();
    activeVoiceCapture.stopSignalSent = true;
    if (isGatewayDirectVoiceProvider(config)) {
      relaySocket.send(JSON.stringify({
        event_id: nextVoiceEventId("commit"),
        type: "input_audio_buffer.commit",
      }));
      return;
    }
    relaySocket.send(JSON.stringify({ type: "stop" }));
  }

  function clearPendingWorkletFlush() {
    if (activeVoiceCapture.pendingFlushTimer) {
      globalScope.clearTimeout(activeVoiceCapture.pendingFlushTimer);
      activeVoiceCapture.pendingFlushTimer = null;
    }
    if (typeof activeVoiceCapture.pendingFlushResolve === "function") {
      const resolve = activeVoiceCapture.pendingFlushResolve;
      activeVoiceCapture.pendingFlushResolve = null;
      activeVoiceCapture.pendingFlushRequestId = 0;
      resolve();
    }
  }

  async function flushPendingWorkletAudio() {
    const workletNode = activeVoiceCapture.workletNode;
    if (!workletNode || typeof workletNode.port?.postMessage !== "function") {
      return;
    }
    clearPendingWorkletFlush();
    const requestId = activeVoiceCapture.flushRequestId + 1;
    activeVoiceCapture.flushRequestId = requestId;
    await new Promise((resolve) => {
      activeVoiceCapture.pendingFlushRequestId = requestId;
      activeVoiceCapture.pendingFlushResolve = resolve;
      activeVoiceCapture.pendingFlushTimer = globalScope.setTimeout(() => {
        clearPendingWorkletFlush();
      }, VOICE_WORKLET_FLUSH_TIMEOUT_MS);
      workletNode.port.postMessage({ type: "flush", requestId });
    });
  }

  function sendAudioChunkToRelay(channelData, inputSampleRate, level = null) {
    if (!(channelData instanceof Float32Array) || channelData.length === 0) {
      return;
    }
    const config = readStoredVoiceInputConfig();
    const captureActive = isLiveVoiceCapturePhase();
    if (level !== null && captureActive) {
      setVoiceButtonLevel(smoothVoiceLevel(level));
    }
    if (!captureActive) {
      return;
    }
    const downsampled = downsampleTo16kHz(channelData, inputSampleRate);
    if (downsampled.length === 0) {
      return;
    }
    const pcmBytes = convertFloat32ToPcm16(downsampled);
    const relaySocket = activeVoiceCapture.relaySocket;
    if (
      !relaySocket
      || relaySocket.readyState !== WebSocket.OPEN
      || activeVoiceCapture.relayReady !== true
    ) {
      bufferAudioFrame(pcmBytes);
      return;
    }
    flushBufferedAudioFrames();
    if (isGatewayDirectVoiceProvider(config)) {
      relaySocket.send(JSON.stringify({
        event_id: nextVoiceEventId("audio"),
        type: "input_audio_buffer.append",
        audio: bytesToBase64(new Uint8Array(pcmBytes)),
      }));
      return;
    }
    relaySocket.send(pcmBytes);
  }

  async function disposeVoiceNodes() {
    clearPendingWorkletFlush();
    if (activeVoiceCapture.workletNode) {
      try { activeVoiceCapture.workletNode.port.onmessage = null; } catch {}
      try { activeVoiceCapture.workletNode.disconnect(); } catch {}
      activeVoiceCapture.workletNode = null;
    }
    if (activeVoiceCapture.processorNode) {
      try { activeVoiceCapture.processorNode.disconnect(); } catch {}
      activeVoiceCapture.processorNode.onaudioprocess = null;
      activeVoiceCapture.processorNode = null;
    }
    if (activeVoiceCapture.sourceNode) {
      try { activeVoiceCapture.sourceNode.disconnect(); } catch {}
      activeVoiceCapture.sourceNode = null;
    }
    if (activeVoiceCapture.silenceNode) {
      try { activeVoiceCapture.silenceNode.disconnect(); } catch {}
      activeVoiceCapture.silenceNode = null;
    }
    if (activeVoiceCapture.mediaStream) {
      for (const track of activeVoiceCapture.mediaStream.getTracks()) {
        try { track.stop(); } catch {}
      }
      activeVoiceCapture.mediaStream = null;
    }
    if (activeVoiceCapture.audioContext) {
      try {
        await activeVoiceCapture.audioContext.close();
      } catch {}
      activeVoiceCapture.audioContext = null;
    }
  }

  function resetVoiceCaptureState() {
    activeVoiceCapture.sessionId = "";
    activeVoiceCapture.phase = "idle";
    activeVoiceCapture.baseText = "";
    activeVoiceCapture.transcript = "";
    activeVoiceCapture.lastErrorMessage = "";
    activeVoiceCapture.stopRequested = false;
    activeVoiceCapture.relaySocket = null;
    activeVoiceCapture.relayReady = false;
    activeVoiceCapture.stopSignalSent = false;
    activeVoiceCapture.voiceLevel = 0;
    activeVoiceCapture.eventCounter = 0;
    activeVoiceCapture.flushRequestId = 0;
    activeVoiceCapture.pendingFlushRequestId = 0;
    activeVoiceCapture.pendingFlushResolve = null;
    activeVoiceCapture.pendingFlushTimer = null;
    activeVoiceCapture.bufferedAudioFrames = [];
    activeVoiceCapture.bufferedAudioBytes = 0;
    setVoiceButtonLevel(0);
    refreshVoiceButtonUi();
  }

  async function cleanupVoiceCapture() {
    const relaySocket = activeVoiceCapture.relaySocket;
    activeVoiceCapture.relaySocket = null;
    if (relaySocket && relaySocket.readyState <= 1) {
      try { relaySocket.close(); } catch {}
    }
    await disposeVoiceNodes();
    resetVoiceCaptureState();
  }

  function markVoiceTransportReady() {
    activeVoiceCapture.relayReady = true;
    if (!activeVoiceCapture.stopRequested && activeVoiceCapture.phase === "connecting") {
      activeVoiceCapture.phase = "recording";
    }
    flushBufferedAudioFrames();
    refreshVoiceButtonUi();
  }

  async function handleGatewayDirectVoiceMessage(event) {
    let payload = null;
    try {
      payload = JSON.parse(String(event?.data || ""));
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") {
      return;
    }

    if (payload.type === "transcription_session.created" || payload.type === "transcription_session.updated") {
      console.info("[voice] Gateway session ready", {
        type: payload.type,
      });
      markVoiceTransportReady();
      if (activeVoiceCapture.stopRequested) {
        await flushPendingWorkletAudio();
        sendVoiceTransportStopSignal();
      }
      return;
    }

    if (payload.type === "conversation.item.input_audio_transcription.delta") {
      appendTranscriptFragmentToComposer(payload.delta);
      return;
    }

    if (payload.type === "conversation.item.input_audio_transcription.result") {
      applyTranscriptToComposer(payload.transcript || payload.text || payload.delta);
      return;
    }

    if (payload.type === "conversation.item.input_audio_transcription.completed") {
      reportVoiceInputRuntimeStatus("", { hidden: true });
      applyTranscriptToComposer(payload.transcript || payload.text || activeVoiceCapture.transcript);
      await cleanupVoiceCapture();
      return;
    }

    if (payload.type === "error") {
      const friendlyMessage = getFriendlyVoiceErrorMessage(payload);
      activeVoiceCapture.lastErrorMessage = friendlyMessage;
      console.error("[voice] Gateway direct error", {
        code: trimString(payload?.code || payload?.error?.code),
        message: trimString(payload?.message || payload?.error?.message) || "unknown",
        friendlyMessage,
      });
      reportVoiceInputRuntimeStatus(friendlyMessage);
      await cleanupVoiceCapture();
      flashVoiceButtonText(t("voice.button.failed"));
    }
  }

  function attachGatewayDirectSocketHandlers(gatewaySocket, config) {
    gatewaySocket.addEventListener("open", () => {
      const payload = buildGatewayDirectSessionUpdatePayload(config);
      console.info("[voice] Gateway direct socket opened", summarizeVoiceConfig(config));
      gatewaySocket.send(JSON.stringify(payload));
    });

    gatewaySocket.addEventListener("message", (event) => {
      void handleGatewayDirectVoiceMessage(event);
    });

    gatewaySocket.addEventListener("close", async (event) => {
      console.info("[voice] Gateway direct socket closed", {
        code: event?.code,
        reason: trimString(event?.reason),
        wasClean: event?.wasClean === true,
      });
      if (!activeVoiceCapture.stopRequested && activeVoiceCapture.phase !== "idle" && !activeVoiceCapture.lastErrorMessage && event?.code && event.code !== 1000) {
        reportVoiceInputRuntimeStatus(t("voice.error.relayClosed"));
      }
      await cleanupVoiceCapture();
    });

    gatewaySocket.addEventListener("error", async (event) => {
      console.error("[voice] Gateway direct socket transport error", event);
      if (!activeVoiceCapture.lastErrorMessage) {
        reportVoiceInputRuntimeStatus(t("voice.error.relayClosed"));
      }
      await cleanupVoiceCapture();
    });
  }

  async function startAudioStreaming() {
    if (!activeVoiceCapture.mediaStream) return;
    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor) {
      throw new Error("Voice input is not supported in this browser");
    }
    const audioContext = new AudioContextCtor();
    const sourceNode = audioContext.createMediaStreamSource(activeVoiceCapture.mediaStream);
    const silenceNode = typeof audioContext.createGain === "function"
      ? audioContext.createGain()
      : null;
    if (silenceNode) {
      silenceNode.gain.value = 0;
    }
    let captureNode = null;

    if (hasAudioWorkletSupport() && typeof audioContext.audioWorklet?.addModule === "function") {
      try {
        await audioContext.audioWorklet.addModule(resolveVoiceWorkletModulePath());
        if (!isLiveVoiceCapturePhase()) {
          try { await audioContext.close(); } catch {}
          return;
        }
        const workletNode = new globalScope.AudioWorkletNode(
          audioContext,
          VOICE_WORKLET_PROCESSOR_NAME,
          {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
            processorOptions: {
              chunkFrames: VOICE_WORKLET_CHUNK_FRAMES,
            },
          },
        );
        workletNode.port.onmessage = (event) => {
          const payload = event?.data;
          if (!payload || typeof payload !== "object") {
            return;
          }
          if (payload.type === "audio") {
            const samples = payload.samples instanceof Float32Array
              ? payload.samples
              : null;
            sendAudioChunkToRelay(
              samples,
              toFiniteNumber(payload.sampleRate) || audioContext.sampleRate,
              normalizeVoiceLevel(payload.level),
            );
            return;
          }
          if (payload.type === "flushed" && payload.requestId === activeVoiceCapture.pendingFlushRequestId) {
            clearPendingWorkletFlush();
          }
        };
        sourceNode.connect(workletNode);
        captureNode = workletNode;
        activeVoiceCapture.workletNode = workletNode;
        console.info("[voice] Audio capture using AudioWorklet");
      } catch (error) {
        console.warn("[voice] AudioWorklet unavailable, falling back to ScriptProcessor", error?.message || error);
      }
    }

    if (!captureNode) {
      if (typeof audioContext.createScriptProcessor !== "function") {
        throw new Error("Voice input audio processing is not supported in this browser");
      }
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      processorNode.onaudioprocess = (event) => {
        const inputBuffer = event?.inputBuffer;
        const channelData = inputBuffer?.getChannelData ? inputBuffer.getChannelData(0) : null;
        if (!(channelData instanceof Float32Array) || channelData.length === 0) {
          return;
        }
        sendAudioChunkToRelay(
          channelData,
          inputBuffer.sampleRate,
          calculateAudioLevel(channelData),
        );
      };
      sourceNode.connect(processorNode);
      captureNode = processorNode;
      activeVoiceCapture.processorNode = processorNode;
      console.info("[voice] Audio capture using ScriptProcessor fallback");
    }

    if (silenceNode) {
      captureNode.connect(silenceNode);
      silenceNode.connect(audioContext.destination);
    } else {
      captureNode.connect(audioContext.destination);
    }
    if (typeof audioContext.resume === "function") {
      await audioContext.resume().catch(() => {});
    }

    activeVoiceCapture.audioContext = audioContext;
    activeVoiceCapture.sourceNode = sourceNode;
    activeVoiceCapture.silenceNode = silenceNode;
    refreshVoiceButtonUi();
  }

  async function stopVoiceCapture({ abandon = false } = {}) {
    const relaySocket = activeVoiceCapture.relaySocket;
    if (!relaySocket) {
      await cleanupVoiceCapture();
      return;
    }
    if (abandon || relaySocket.readyState !== WebSocket.OPEN) {
      await cleanupVoiceCapture();
      return;
    }
    activeVoiceCapture.stopRequested = true;
    activeVoiceCapture.phase = "stopping";
    refreshVoiceButtonUi();
    await flushPendingWorkletAudio();
    if (relaySocket.readyState !== WebSocket.OPEN || activeVoiceCapture.relayReady !== true) {
      return;
    }
    sendVoiceTransportStopSignal();
  }

  async function startVoiceCapture() {
    if (activeVoiceCapture.phase !== "idle") {
      await stopVoiceCapture();
      return;
    }
    if (!msgInput) return;
    const config = readStoredVoiceInputConfig();
    if (!hasVoiceInputSupport()) {
      return;
    }
    if (!isVoiceInputConfigured(config)) {
      return;
    }
    const session = getCurrentSessionSnapshot();
    if (!session?.id || session.archived) {
      return;
    }

    const mediaStream = await globalScope.navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
    });

    activeVoiceCapture.sessionId = session.id;
    activeVoiceCapture.phase = "connecting";
    activeVoiceCapture.baseText = msgInput.value || "";
    activeVoiceCapture.transcript = "";
    activeVoiceCapture.lastErrorMessage = "";
    activeVoiceCapture.mediaStream = mediaStream;
    activeVoiceCapture.relayReady = false;
    activeVoiceCapture.stopRequested = false;
    activeVoiceCapture.stopSignalSent = false;
    activeVoiceCapture.bufferedAudioFrames = [];
    activeVoiceCapture.bufferedAudioBytes = 0;
    setVoiceButtonLevel(0);
    refreshVoiceButtonUi();
    reportVoiceInputRuntimeStatus("", { hidden: true });
    if (isGatewayDirectVoiceProvider(config)) {
      const gatewayUrl = resolveVoiceGatewayUrl(config);
      const gatewayProtocols = buildGatewayDirectAuthSubprotocols(config.gatewayApiKey);
      console.info("[voice] Opening gateway direct socket", {
        ...summarizeVoiceConfig(config),
        gatewayUrl,
      });
      const gatewaySocket = new WebSocket(gatewayUrl, gatewayProtocols);
      activeVoiceCapture.relaySocket = gatewaySocket;
      attachGatewayDirectSocketHandlers(gatewaySocket, config);
    } else {
      console.info("[voice] Opening relay socket", summarizeVoiceConfig(config));
      const relaySocket = new WebSocket(resolveVoiceRelayUrl());
      activeVoiceCapture.relaySocket = relaySocket;

      relaySocket.addEventListener("open", () => {
        console.info("[voice] Relay socket opened");
        relaySocket.send(JSON.stringify({ type: "start" }));
      });

      relaySocket.addEventListener("message", async (event) => {
        let payload = null;
        try {
          payload = JSON.parse(String(event?.data || ""));
        } catch {
          return;
        }
        if (payload?.type === "status" && payload.phase === "ready") {
          console.info("[voice] Relay ready", {
            traceId: trimString(payload.traceId),
            logId: trimString(payload.logId),
          });
          markVoiceTransportReady();
          if (activeVoiceCapture.stopRequested) {
            await flushPendingWorkletAudio();
            sendVoiceTransportStopSignal();
          }
          return;
        }
        if (payload?.type === "transcript") {
          applyTranscriptToComposer(payload.transcript);
          return;
        }
        if (payload?.type === "done") {
          console.info("[voice] Relay completed", {
            traceId: trimString(payload?.traceId),
            logId: trimString(payload?.logId),
          });
          reportVoiceInputRuntimeStatus("", { hidden: true });
          applyTranscriptToComposer(payload.transcript || activeVoiceCapture.transcript);
          await cleanupVoiceCapture();
          return;
        }
        if (payload?.type === "error") {
          const friendlyMessage = getFriendlyVoiceErrorMessage(payload);
          activeVoiceCapture.lastErrorMessage = friendlyMessage;
          console.error("[voice] Relay error", {
            traceId: trimString(payload?.traceId),
            logId: trimString(payload?.logId),
            code: trimString(payload?.code),
            message: trimString(payload?.message) || "unknown",
            friendlyMessage,
          });
          reportVoiceInputRuntimeStatus(friendlyMessage);
          await cleanupVoiceCapture();
          flashVoiceButtonText(t("voice.button.failed"));
        }
      });

      relaySocket.addEventListener("close", async (event) => {
        console.info("[voice] Relay socket closed", {
          code: event?.code,
          reason: trimString(event?.reason),
          wasClean: event?.wasClean === true,
        });
        if (!activeVoiceCapture.stopRequested && activeVoiceCapture.phase !== "idle" && !activeVoiceCapture.lastErrorMessage && event?.code && event.code !== 1000) {
          reportVoiceInputRuntimeStatus(t("voice.error.relayClosed"));
        }
        await cleanupVoiceCapture();
      });

      relaySocket.addEventListener("error", async (event) => {
        console.error("[voice] Relay socket transport error", event);
        if (!activeVoiceCapture.lastErrorMessage) {
          reportVoiceInputRuntimeStatus(t("voice.error.relayClosed"));
        }
        await cleanupVoiceCapture();
      });
    }

    void startAudioStreaming().catch((error) => {
      console.warn("[voice] Failed to start audio streaming:", error?.message || error);
      reportVoiceInputRuntimeStatus(trimString(error?.message) || t("voice.error.relayClosed"));
      void cleanupVoiceCapture();
      flashVoiceButtonText(t("voice.button.failed"));
    });
  }

  if (voiceBtn && voiceBtn.dataset.bound !== "true") {
    voiceBtn.addEventListener("click", () => {
      void startVoiceCapture().catch((error) => {
        console.warn("[voice] Failed to start capture:", error?.message || error);
        reportVoiceInputRuntimeStatus(trimString(error?.message) || t("voice.error.relayClosed"));
        void cleanupVoiceCapture();
        flashVoiceButtonText(t("voice.button.failed"));
      });
    });
    voiceBtn.dataset.bound = "true";
  }

  globalScope.remotelabGetVoiceInputConfig = readStoredVoiceInputConfig;
  globalScope.remotelabSetVoiceInputConfig = writeStoredVoiceInputConfig;
  globalScope.remotelabNormalizeVoiceInputConfig = normalizeVoiceInputConfig;
  globalScope.remotelabGetVoiceInputLanguageOptions = getVoiceInputLanguageOptions;
  globalScope.remotelabGetVoiceInputClusterOptions = getVoiceInputClusterOptions;
  globalScope.remotelabRefreshVoiceInputUi = refreshVoiceButtonUi;
  globalScope.remotelabIsVoiceInputConfigured = function remotelabIsVoiceInputConfigured() {
    return isVoiceInputConfigured(readStoredVoiceInputConfig());
  };

  globalScope.addEventListener("remotelab:instancesettingschange", refreshVoiceButtonUi);
  globalScope.addEventListener("remotelab:localechange", refreshVoiceButtonUi);
  refreshVoiceButtonUi();
})(window);
