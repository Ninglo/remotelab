"use strict";

(function bootstrapVoiceGatewayDirectPoc(globalScope) {
  const TARGET_SAMPLE_RATE = 16000;
  const INPUT_CHANNELS = 1;
  const INPUT_BITS = 16;
  const SUBPROTOCOL_TEMPLATE = Object.freeze([
    "realtime",
    "openai-insecure-api-key.%API_KEY%",
    "openai-beta.realtime-v1",
  ]);

  const state = {
    socket: null,
    phase: "idle",
    eventCounter: 0,
    audioContext: null,
    mediaStream: null,
    sourceNode: null,
    processorNode: null,
    transcript: "",
  };

  const gatewayUrlInput = globalScope.document.getElementById("gatewayUrlInput");
  const apiKeyInput = globalScope.document.getElementById("apiKeyInput");
  const resultTypeSelect = globalScope.document.getElementById("resultTypeSelect");
  const languageHintInput = globalScope.document.getElementById("languageHintInput");
  const sessionPayloadPreview = globalScope.document.getElementById("sessionPayloadPreview");
  const connectBtn = globalScope.document.getElementById("connectBtn");
  const disconnectBtn = globalScope.document.getElementById("disconnectBtn");
  const startMicBtn = globalScope.document.getElementById("startMicBtn");
  const stopMicBtn = globalScope.document.getElementById("stopMicBtn");
  const statusBox = globalScope.document.getElementById("statusBox");
  const logBox = globalScope.document.getElementById("logBox");
  const transcriptBox = globalScope.document.getElementById("transcriptBox");

  function trimString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function nextEventId(prefix = "event") {
    state.eventCounter += 1;
    return `${prefix}_${Date.now()}_${state.eventCounter}`;
  }

  function log(message, payload = null) {
    const stamp = new Date().toISOString();
    const serialized = payload === null
      ? ""
      : `\n${typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)}`;
    logBox.textContent = `${stamp} ${message}${serialized}\n\n${logBox.textContent}`.slice(0, 20000);
  }

  function setStatus(label, variant = "idle") {
    statusBox.className = "status";
    if (variant === "good") statusBox.classList.add("good");
    if (variant === "warn") statusBox.classList.add("warn");
    if (variant === "bad") statusBox.classList.add("bad");
    statusBox.innerHTML = `<strong>${label}</strong>`;
  }

  function updateButtons() {
    const liveSocket = state.socket && state.socket.readyState === globalScope.WebSocket.OPEN;
    const connecting = state.socket && state.socket.readyState === globalScope.WebSocket.CONNECTING;
    const recording = !!state.processorNode;

    connectBtn.disabled = connecting || liveSocket;
    disconnectBtn.disabled = !state.socket;
    startMicBtn.disabled = !liveSocket || recording;
    stopMicBtn.disabled = !recording;
  }

  function buildSessionUpdatePayload() {
    const payload = {
      type: "transcription_session.update",
      session: {
        input_audio_format: "pcm",
        input_audio_codec: "raw",
        input_audio_sample_rate: TARGET_SAMPLE_RATE,
        input_audio_bits: INPUT_BITS,
        input_audio_channel: INPUT_CHANNELS,
        result_type: Number.parseInt(resultTypeSelect.value || "0", 10) || 0,
        turn_detection: null,
        input_audio_transcription: {
          model: "bigmodel",
        },
      },
    };
    const languageHint = trimString(languageHintInput.value);
    if (languageHint) {
      payload.session.input_audio_transcription.language = languageHint;
    }
    return payload;
  }

  function refreshSessionPayloadPreview() {
    sessionPayloadPreview.value = JSON.stringify(buildSessionUpdatePayload(), null, 2);
  }

  function buildAuthSubprotocols(apiKey) {
    return SUBPROTOCOL_TEMPLATE.map((entry) => entry.replace("%API_KEY%", apiKey));
  }

  function appendTranscript(fragment, { overwrite = false } = {}) {
    const cleanFragment = trimString(fragment);
    if (!cleanFragment) return;
    state.transcript = overwrite ? cleanFragment : `${state.transcript} ${cleanFragment}`.trim();
    transcriptBox.textContent = state.transcript || "No transcript yet.";
  }

  function resetTranscript() {
    state.transcript = "";
    transcriptBox.textContent = "No transcript yet.";
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function sendJson(payload) {
    if (!state.socket || state.socket.readyState !== globalScope.WebSocket.OPEN) {
      throw new Error("Socket is not open");
    }
    state.socket.send(JSON.stringify(payload));
  }

  function downsampleTo16kHz(channelData, inputSampleRate) {
    if (!(channelData instanceof Float32Array) || channelData.length === 0) {
      return new Float32Array(0);
    }
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= TARGET_SAMPLE_RATE) {
      return channelData;
    }
    const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
    const outputLength = Math.max(1, Math.round(channelData.length / ratio));
    const result = new Float32Array(outputLength);
    let offsetInput = 0;
    for (let index = 0; index < outputLength; index += 1) {
      const nextOffset = Math.round((index + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let cursor = offsetInput; cursor < nextOffset && cursor < channelData.length; cursor += 1) {
        sum += channelData[cursor];
        count += 1;
      }
      result[index] = count > 0 ? sum / count : 0;
      offsetInput = nextOffset;
    }
    return result;
  }

  function float32ToPcm16Bytes(samples) {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const slice = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode.apply(null, slice);
    }
    return globalScope.btoa(binary);
  }

  async function stopMicCapture({ commit = true } = {}) {
    if (state.processorNode) {
      try { state.processorNode.disconnect(); } catch {}
      state.processorNode.onaudioprocess = null;
      state.processorNode = null;
    }
    if (state.sourceNode) {
      try { state.sourceNode.disconnect(); } catch {}
      state.sourceNode = null;
    }
    if (state.mediaStream) {
      for (const track of state.mediaStream.getTracks()) {
        try { track.stop(); } catch {}
      }
      state.mediaStream = null;
    }
    if (state.audioContext) {
      try { await state.audioContext.close(); } catch {}
      state.audioContext = null;
    }
    if (commit && state.socket && state.socket.readyState === globalScope.WebSocket.OPEN) {
      const payload = {
        event_id: nextEventId(),
        type: "input_audio_buffer.commit",
      };
      sendJson(payload);
      log("-> input_audio_buffer.commit", payload);
    }
    updateButtons();
  }

  async function startMicCapture() {
    if (!state.socket || state.socket.readyState !== globalScope.WebSocket.OPEN) {
      throw new Error("Connect the gateway first");
    }
    const mediaStream = await globalScope.navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
    });

    const AudioContextCtor = globalScope.AudioContext || globalScope.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("This browser does not expose AudioContext");
    }

    const audioContext = new AudioContextCtor();
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const processorNode = audioContext.createScriptProcessor(4096, 1, 1);

    processorNode.onaudioprocess = (event) => {
      if (!state.socket || state.socket.readyState !== globalScope.WebSocket.OPEN) {
        return;
      }
      const channelData = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleTo16kHz(channelData, audioContext.sampleRate);
      if (downsampled.length === 0) return;
      const audioBytes = float32ToPcm16Bytes(downsampled);
      const payload = {
        event_id: nextEventId(),
        type: "input_audio_buffer.append",
        audio: bytesToBase64(audioBytes),
      };
      sendJson(payload);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    state.audioContext = audioContext;
    state.mediaStream = mediaStream;
    state.sourceNode = sourceNode;
    state.processorNode = processorNode;
    setStatus("Recording mic directly to gateway", "good");
    log("Mic capture started", { inputSampleRate: audioContext.sampleRate });
    updateButtons();
  }

  async function disconnectSocket() {
    await stopMicCapture({ commit: false });
    if (state.socket) {
      try { state.socket.close(1000, "manual-disconnect"); } catch {}
      state.socket = null;
    }
    state.phase = "idle";
    setStatus("Idle", "idle");
    updateButtons();
  }

  async function connectSocket() {
    const gatewayUrl = trimString(gatewayUrlInput.value);
    const apiKey = trimString(apiKeyInput.value);
    if (!gatewayUrl) {
      throw new Error("Gateway URL is required");
    }
    if (!apiKey) {
      throw new Error("API key is required");
    }

    await disconnectSocket();
    resetTranscript();

    const protocols = buildAuthSubprotocols(apiKey);
    const socket = new globalScope.WebSocket(gatewayUrl, protocols);
    state.socket = socket;
    state.phase = "connecting";
    setStatus("Connecting with inferred subprotocol auth", "warn");
    log("Opening websocket", { gatewayUrl, protocols });
    updateButtons();

    socket.addEventListener("open", () => {
      state.phase = "connected";
      const payload = buildSessionUpdatePayload();
      sendJson(payload);
      setStatus("Connected, waiting for session confirmation", "good");
      log("-> transcription_session.update", payload);
      updateButtons();
    });

    socket.addEventListener("message", (event) => {
      const raw = String(event.data || "");
      const payload = safeJsonParse(raw);
      log("<- message", payload || raw);

      if (!payload || typeof payload !== "object") return;
      if (payload.type === "transcription_session.updated") {
        setStatus("Session updated, gateway accepted the transcription config", "good");
        return;
      }
      if (payload.type === "conversation.item.input_audio_transcription.delta") {
        appendTranscript(payload.delta);
        return;
      }
      if (payload.type === "conversation.item.input_audio_transcription.result") {
        appendTranscript(payload.transcript || payload.text || payload.delta, { overwrite: true });
        return;
      }
      if (payload.type === "conversation.item.input_audio_transcription.completed") {
        appendTranscript(payload.transcript || payload.text, { overwrite: true });
        setStatus("Transcript completed for this utterance", "good");
        return;
      }
      if (payload.type === "error") {
        const errorMessage = trimString(payload.error?.message) || "Gateway returned an error";
        setStatus(`Gateway error: ${errorMessage}`, "bad");
      }
    });

    socket.addEventListener("close", async (event) => {
      log("Socket closed", {
        code: event.code,
        reason: trimString(event.reason),
        wasClean: event.wasClean === true,
      });
      await stopMicCapture({ commit: false });
      state.socket = null;
      state.phase = "idle";
      setStatus("Disconnected", event.code === 1000 ? "idle" : "warn");
      updateButtons();
    });

    socket.addEventListener("error", () => {
      setStatus("Socket transport error", "bad");
      log("Socket transport error");
    });
  }

  connectBtn.addEventListener("click", () => {
    void connectSocket().catch((error) => {
      setStatus(trimString(error?.message) || "Failed to connect", "bad");
      log("Connect failed", trimString(error?.stack) || trimString(error?.message) || String(error));
      updateButtons();
    });
  });

  disconnectBtn.addEventListener("click", () => {
    void disconnectSocket();
  });

  startMicBtn.addEventListener("click", () => {
    void startMicCapture().catch((error) => {
      setStatus(trimString(error?.message) || "Failed to start microphone", "bad");
      log("Mic start failed", trimString(error?.stack) || trimString(error?.message) || String(error));
      updateButtons();
    });
  });

  stopMicBtn.addEventListener("click", () => {
    void stopMicCapture({ commit: true }).catch((error) => {
      setStatus(trimString(error?.message) || "Failed to stop microphone", "bad");
      log("Mic stop failed", trimString(error?.stack) || trimString(error?.message) || String(error));
      updateButtons();
    });
  });

  resultTypeSelect.addEventListener("change", refreshSessionPayloadPreview);
  languageHintInput.addEventListener("input", refreshSessionPayloadPreview);
  gatewayUrlInput.addEventListener("change", refreshSessionPayloadPreview);

  refreshSessionPayloadPreview();
  updateButtons();
})(window);
