"use strict";

(function attachRemoteLabVoiceInput(globalScope) {
  const DOUBAO_VOICE_WS_PATH = "/ws/voice-input/doubao";
  const VOICE_PROVIDER_GATEWAY_DIRECT = "doubao_gateway_direct";
  const VOICE_WORKLET_MODULE_PATH = "/chat/voice-input-worklet.js";
  const VOICE_WORKLET_PROCESSOR_NAME = "remotelab-voice-input-processor";
  const VOICE_SAMPLE_RATE = 16000;
  const VOICE_WORKLET_CHUNK_FRAMES = 2048;
  const VOICE_WORKLET_FLUSH_TIMEOUT_MS = 120;
  const VOICE_AUDIO_START_TIMEOUT_MS = 5000;
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
    captureId: 0,
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
  let voiceRequestGeneration = 0;
  let voiceCleanupPromise = null;
  let microphoneStream = null;
  let microphoneContext = null;
  let microphonePreparation = null;
  let cancelMicrophonePreparation = null;
  let microphoneError = "";
  let microphoneExpiry = null;
  let microphoneEpoch = 0;
  let microphoneAuthorized = false;

  function releaseMicrophone() {
    microphoneEpoch += 1;
    globalScope.clearTimeout(microphoneExpiry);
    microphoneExpiry = null;
    microphonePreparation = null;
    cancelMicrophonePreparation?.();
    cancelMicrophonePreparation = null;
    for (const track of microphoneStream?.getTracks() || []) track.stop();
    microphoneStream = null;
    void microphoneContext?.close().catch(() => {});
    microphoneContext = null;
  }

  function keepMicrophoneQuiet() {
    for (const track of microphoneStream?.getTracks() || []) track.enabled = false;
    globalScope.clearTimeout(microphoneExpiry);
    // Reuse only during consecutive takes on this visible page; never in the background.
    microphoneExpiry = globalScope.setTimeout(releaseMicrophone, 60000);
  }

  function prepareMicrophone() {
    if (getVoiceUnavailableReason()) return Promise.reject(new Error(getVoiceUnavailableReason()));
    globalScope.clearTimeout(microphoneExpiry);
    if (microphoneContext?.state === "interrupted"
      || microphoneStream?.getTracks().some((track) => track.readyState === "ended")) releaseMicrophone();
    // The hold timer shares the preparation begun in pointerdown; it must not resume audio again.
    if (microphonePreparation) return microphonePreparation;
    microphoneError = "";
    // Create and resume in the actual user gesture, before the hold timer or permission promise.
    if (!microphoneContext || microphoneContext.state === "closed") {
      microphoneContext = new (getAudioContextConstructor())();
    }
    const resuming = microphoneContext.state === "running" ? Promise.resolve()
      : microphoneContext.resume?.() || Promise.resolve();
    const epoch = microphoneEpoch;
    const resumed = Promise.resolve(resuming).then(() => null, (error) => error);
    let cancel, deadline;
    const cancelled = new Promise((resolve) => { cancel = () => resolve(null); });
    cancelMicrophonePreparation = cancel;
    const acquiring = microphoneStream ? Promise.resolve(microphoneStream) : globalScope.navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
    });
    const preparing = acquiring.then(async (stream) => {
      if (epoch !== microphoneEpoch || globalScope.document?.hidden) {
        for (const track of stream.getTracks()) track.stop();
        return null;
      }
      // Own and silence the device before awaiting audio startup so cancellation can always release it.
      microphoneStream = stream;
      microphoneAuthorized = true;
      for (const track of stream.getTracks()) track.enabled = false;
      const timeout = new Promise((resolve) => {
        deadline = globalScope.setTimeout(() => {
          const error = new Error(t("voice.mobile.audioPaused"));
          error.code = "VOICE_AUDIO_START_TIMEOUT";
          resolve(error);
        }, VOICE_AUDIO_START_TIMEOUT_MS);
      });
      // Wait for permission without a timer; only audio startup after the grant has a deadline.
      const resumeError = await Promise.race([resumed, cancelled, timeout]);
      if (epoch !== microphoneEpoch) return null;
      if (resumeError) throw resumeError;
      if (activeVoiceCapture.phase === "idle") keepMicrophoneQuiet();
      return stream;
    });
    const pending = Promise.race([preparing, cancelled]).catch((error) => {
      if (epoch !== microphoneEpoch) return null;
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") microphoneAuthorized = false;
      if (error?.code === "VOICE_AUDIO_START_TIMEOUT") microphoneError = error.message;
      releaseMicrophone();
      throw error;
    }).finally(() => {
      globalScope.clearTimeout(deadline);
      if (microphonePreparation === pending) microphonePreparation = null;
      if (cancelMicrophonePreparation === cancel) cancelMicrophonePreparation = null;
      refreshVoiceButtonUi();
    });
    microphonePreparation = pending;
    return pending;
  }

  function getVoiceCaptureState() {
    const { captureId, sessionId, phase, baseText, transcript, voiceLevel } = activeVoiceCapture;
    return { captureId, sessionId, phase, baseText, transcript, voiceLevel,
      microphoneAuthorized, microphonePreparing: !!microphonePreparation, microphoneError };
  }

  const voiceBtn = globalScope.document?.getElementById("voiceBtn") || null;
  const voiceAvailabilityStatus = globalScope.document?.getElementById("voiceAvailabilityStatus") || null;

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
    return phase === "requesting" || phase === "connecting" || phase === "recording" || phase === "stopping";
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

  function isVoiceInputServerOnly(config = readStoredVoiceInputConfig()) {
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

  function getVoiceUnavailableReason(config = readStoredVoiceInputConfig()) {
    if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode === true) return t("voice.unavailable.snapshot");
    if (globalScope.isSecureContext === false) return t("voice.unavailable.https");
    if (!hasVoiceInputSupport()) return t("voice.unavailable.browser");
    if (isVoiceInputServerOnly(config) || !isVoiceInputConfigured(config)) return t("voice.unavailable.setup");
    if (!msgInput || msgInput.disabled) return t("voice.unavailable.composer");
    const sessionId = typeof currentSessionId === "string" ? currentSessionId : "";
    if (sessionId && getCurrentSessionSnapshot()?.id !== sessionId) return t("voice.unavailable.loading");
    return "";
  }

  function getVoiceButtonLabel() {
    switch (activeVoiceCapture.phase) {
      case "requesting":
      case "connecting":
        return t("voice.button.connecting");
      case "recording":
      case "stopping":
        return t("voice.button.stop");
      default:
        return getVoiceUnavailableReason() || t("action.voiceInput");
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
    const unavailableReason = getVoiceUnavailableReason(config);
    const isActive = isLiveVoiceCapturePhase();
    const showLiveCaptureState = !!activeVoiceCapture.audioContext
      && (activeVoiceCapture.phase === "connecting" || activeVoiceCapture.phase === "recording");

    voiceBtn.disabled = isActive ? false : !!unavailableReason;
    if (voiceAvailabilityStatus) {
      voiceAvailabilityStatus.hidden = isActive || !unavailableReason;
      voiceAvailabilityStatus.textContent = voiceAvailabilityStatus.hidden ? "" : unavailableReason;
    }
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
    if (typeof globalScope.dispatchEvent === "function" && typeof CustomEvent === "function") {
      globalScope.dispatchEvent(new CustomEvent("remotelab:voice-state-change", { detail: getVoiceCaptureState() }));
    }
  }

  function resolveVoiceRelayUrl() {
    const proto = globalScope.location?.protocol === "https:" ? "wss:" : "ws:";
    const relativePath = typeof resolveProductRequestUrl === "function"
      ? resolveProductRequestUrl(DOUBAO_VOICE_WS_PATH)
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
    if (activeVoiceCapture.sessionId !== (typeof currentSessionId === "string" ? currentSessionId : "") || msgInput.disabled) {
      void stopVoiceCapture({ abandon: true });
      return;
    }
    activeVoiceCapture.transcript = trimString(transcript);
    msgInput.value = joinComposerText(activeVoiceCapture.baseText, formatTranscriptForComposer(activeVoiceCapture.transcript));
    dispatchComposerInputEvent();
  }

  function formatTranscriptForComposer(transcript) {
    const formatter = globalScope.remotelabFormatVoiceTranscriptLive;
    const formatted = typeof formatter === "function" ? formatter(transcript) : transcript;
    return typeof formatted === "string" && formatted.trim() ? formatted : transcript;
  }

  function announceFinalTranscript() {
    const transcript = trimString(activeVoiceCapture.transcript);
    if (!transcript || !msgInput) return;
    globalScope.dispatchEvent(new CustomEvent("remotelab:voice-transcript-complete", {
      detail: {
        captureId: activeVoiceCapture.captureId,
        transcript,
        composerText: msgInput.value,
        displayedTranscript: formatTranscriptForComposer(transcript),
        rawComposerText: joinComposerText(activeVoiceCapture.baseText, transcript),
        sessionId: activeVoiceCapture.sessionId,
      },
    }));
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
      keepMicrophoneQuiet();
      activeVoiceCapture.mediaStream = null;
    }
    if (activeVoiceCapture.audioContext) {
      activeVoiceCapture.audioContext = null;
    }
  }

  function resetVoiceCaptureState() {
    activeVoiceCapture.captureId = 0;
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
    if (voiceCleanupPromise) return voiceCleanupPromise;
    voiceRequestGeneration += 1;
    const relaySocket = activeVoiceCapture.relaySocket;
    activeVoiceCapture.relaySocket = null;
    if (relaySocket && relaySocket.readyState <= 1) {
      try { relaySocket.close(); } catch {}
    }
    voiceCleanupPromise = disposeVoiceNodes().then(resetVoiceCaptureState);
    try { await voiceCleanupPromise; } finally { voiceCleanupPromise = null; }
  }

  function markVoiceTransportReady() {
    activeVoiceCapture.relayReady = true;
    if (!activeVoiceCapture.stopRequested && activeVoiceCapture.phase === "connecting" && activeVoiceCapture.audioContext) {
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
      announceFinalTranscript();
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
      if (gatewaySocket !== activeVoiceCapture.relaySocket) return;
      const payload = buildGatewayDirectSessionUpdatePayload(config);
      console.info("[voice] Gateway direct socket opened", summarizeVoiceConfig(config));
      gatewaySocket.send(JSON.stringify(payload));
    });

    gatewaySocket.addEventListener("message", (event) => {
      if (gatewaySocket !== activeVoiceCapture.relaySocket) return;
      void handleGatewayDirectVoiceMessage(event);
    });

    gatewaySocket.addEventListener("close", async (event) => {
      if (gatewaySocket !== activeVoiceCapture.relaySocket) return;
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
      if (gatewaySocket !== activeVoiceCapture.relaySocket) return;
      console.error("[voice] Gateway direct socket transport error", event);
      if (!activeVoiceCapture.lastErrorMessage) {
        reportVoiceInputRuntimeStatus(t("voice.error.relayClosed"));
      }
      await cleanupVoiceCapture();
    });
  }

  async function startAudioStreaming() {
    if (!activeVoiceCapture.mediaStream) return;
    const captureId = activeVoiceCapture.captureId;
    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor) {
      throw new Error("Voice input is not supported in this browser");
    }
    const audioContext = microphoneContext;
    if (!audioContext || (audioContext.state && audioContext.state !== "running")) {
      throw new Error(t("voice.mobile.audioPaused"));
    }
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
        if (captureId !== activeVoiceCapture.captureId || !isLiveVoiceCapturePhase()) {
          try { sourceNode.disconnect(); } catch {}
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

    if (captureId !== activeVoiceCapture.captureId || !isLiveVoiceCapturePhase()) {
      try { sourceNode.disconnect(); captureNode?.disconnect(); } catch {}
      return;
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
    if (captureId !== activeVoiceCapture.captureId || !isLiveVoiceCapturePhase()) {
      try { sourceNode.disconnect(); captureNode.disconnect(); } catch {}
      return;
    }

    activeVoiceCapture.audioContext = audioContext;
    activeVoiceCapture.sourceNode = sourceNode;
    activeVoiceCapture.silenceNode = silenceNode;
    if (activeVoiceCapture.phase === "connecting") activeVoiceCapture.phase = "recording";
    refreshVoiceButtonUi();
  }

  async function stopVoiceCapture({ abandon = false } = {}) {
    if (abandon && activeVoiceCapture.phase === "requesting") releaseMicrophone();
    const relaySocket = activeVoiceCapture.relaySocket;
    if (!relaySocket) {
      await cleanupVoiceCapture();
      return;
    }
    if (abandon || relaySocket.readyState > WebSocket.OPEN) {
      await cleanupVoiceCapture();
      return;
    }
    activeVoiceCapture.stopRequested = true;
    activeVoiceCapture.phase = "stopping";
    refreshVoiceButtonUi();
    await flushPendingWorkletAudio();
    if (activeVoiceCapture.processorNode) activeVoiceCapture.processorNode.onaudioprocess = null;
    for (const track of activeVoiceCapture.mediaStream?.getTracks() || []) track.enabled = false;
    try { activeVoiceCapture.sourceNode?.disconnect(); } catch {}
    if (relaySocket.readyState !== WebSocket.OPEN || activeVoiceCapture.relayReady !== true) {
      return;
    }
    sendVoiceTransportStopSignal();
  }

  async function startVoiceCapture() {
    if (voiceCleanupPromise) await voiceCleanupPromise;
    if (activeVoiceCapture.phase !== "idle") {
      await stopVoiceCapture();
      return;
    }
    if (!msgInput) return;
    const config = readStoredVoiceInputConfig();
    if (getVoiceUnavailableReason(config)) return;
    const sessionId = typeof currentSessionId === "string" ? currentSessionId : "";
    const baseText = msgInput.value || "";
    const captureId = ++voiceRequestGeneration;
    activeVoiceCapture.captureId = captureId;
    activeVoiceCapture.sessionId = sessionId;
    activeVoiceCapture.baseText = baseText;
    activeVoiceCapture.phase = "requesting";
    refreshVoiceButtonUi();
    let mediaStream;
    try { mediaStream = await prepareMicrophone(); } catch (error) {
      if (captureId !== voiceRequestGeneration) return;
      await cleanupVoiceCapture();
      throw error;
    }
    if (captureId !== voiceRequestGeneration) return;
    if (!mediaStream || sessionId !== (typeof currentSessionId === "string" ? currentSessionId : "")
      || msgInput.disabled || msgInput.value !== baseText) {
      releaseMicrophone();
      await cleanupVoiceCapture();
      return;
    }

    activeVoiceCapture.sessionId = sessionId;
    activeVoiceCapture.phase = "connecting";
    activeVoiceCapture.baseText = baseText;
    activeVoiceCapture.transcript = "";
    activeVoiceCapture.lastErrorMessage = "";
    activeVoiceCapture.mediaStream = mediaStream;
    globalScope.clearTimeout(microphoneExpiry);
    for (const track of mediaStream.getTracks()) track.enabled = true;
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
        if (relaySocket !== activeVoiceCapture.relaySocket) return;
        console.info("[voice] Relay socket opened");
        relaySocket.send(JSON.stringify({ type: "start" }));
      });

      relaySocket.addEventListener("message", async (event) => {
        if (relaySocket !== activeVoiceCapture.relaySocket) return;
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
          announceFinalTranscript();
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
        if (relaySocket !== activeVoiceCapture.relaySocket) return;
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
        if (relaySocket !== activeVoiceCapture.relaySocket) return;
        console.error("[voice] Relay socket transport error", event);
        if (!activeVoiceCapture.lastErrorMessage) {
          reportVoiceInputRuntimeStatus(t("voice.error.relayClosed"));
        }
        await cleanupVoiceCapture();
      });
    }

    void startAudioStreaming().catch((error) => {
      if (captureId !== activeVoiceCapture.captureId) return;
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
  globalScope.remotelabVoiceCapture = {
    getState: getVoiceCaptureState,
    start: startVoiceCapture,
    prepare: prepareMicrophone,
    releaseMicrophone,
    stop: stopVoiceCapture,
    cancel: () => stopVoiceCapture({ abandon: true }),
    whenIdle: () => voiceCleanupPromise || Promise.resolve(),
  };
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
  globalScope.document?.addEventListener?.("visibilitychange", () => {
    if (globalScope.document.hidden) { void stopVoiceCapture({ abandon: true }); releaseMicrophone(); }
  });
  globalScope.addEventListener("pagehide", () => { void stopVoiceCapture({ abandon: true }); releaseMicrophone(); });
  // Read the browser's real permission; a saved app preference is not a grant.
  void globalScope.navigator.permissions?.query({ name: "microphone" }).then((permission) => {
    const update = () => {
      microphoneAuthorized = permission.state === "granted";
      if (permission.state === "denied") { void stopVoiceCapture({ abandon: true }); releaseMicrophone(); }
      refreshVoiceButtonUi();
    };
    permission.addEventListener("change", update);
    update();
  }).catch(() => {});
  refreshVoiceButtonUi();
})(window);
