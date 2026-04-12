import { randomUUID } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import { WebSocket } from 'ws';
import { loadServerVoiceInputSettings } from './instance-settings.mjs';

export const DOUBAO_VOICE_WS_PATH = '/ws/voice-input/doubao';
const DOUBAO_VOICE_UPSTREAM_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
const DOUBAO_FULL_CLIENT_REQUEST_HEADER = Buffer.from([0x11, 0x10, 0x11, 0x00]);
const DOUBAO_AUDIO_PACKET_HEADER = Buffer.from([0x11, 0x20, 0x01, 0x00]);
const DOUBAO_AUDIO_FINAL_PACKET_HEADER = Buffer.from([0x11, 0x22, 0x01, 0x00]);
const DOUBAO_DEFAULT_AUDIO_CONFIG = Object.freeze({
  format: 'pcm',
  rate: 16000,
  bits: 16,
  channel: 1,
});
const DOUBAO_DEFAULT_REQUEST_CONFIG = Object.freeze({
  model_name: 'bigmodel',
  enable_itn: true,
  enable_punc: true,
});

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getJsonString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export function normalizeDoubaoVoiceConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object'
    ? rawConfig
    : {};
  const resourceId = trimString(config.resourceId || config.cluster);
  return {
    provider: 'doubao',
    appId: trimString(config.appId || config.appid),
    accessToken: trimString(config.accessToken || config.token),
    resourceId,
    cluster: resourceId,
    language: trimString(config.language) || 'zh-CN',
  };
}

export function validateDoubaoVoiceConfig(rawConfig) {
  const config = normalizeDoubaoVoiceConfig(rawConfig);
  if (!config.appId) {
    throw new Error('Missing Doubao App ID');
  }
  if (!config.accessToken) {
    throw new Error('Missing Doubao access token');
  }
  if (!config.resourceId) {
    throw new Error('Missing Doubao resource ID');
  }
  return config;
}

function buildPayloadSizeBuffer(size) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(size, 0);
  return buffer;
}

export function buildDoubaoFullClientRequest(rawConfig, overrides = {}) {
  const config = validateDoubaoVoiceConfig(rawConfig);
  const payload = {
    user: {
      uid: trimString(overrides.uid) || 'remotelab-owner',
    },
    audio: { ...DOUBAO_DEFAULT_AUDIO_CONFIG },
    request: {
      ...DOUBAO_DEFAULT_REQUEST_CONFIG,
    },
  };
  const encodedPayload = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  return Buffer.concat([
    DOUBAO_FULL_CLIENT_REQUEST_HEADER,
    buildPayloadSizeBuffer(encodedPayload.length),
    encodedPayload,
  ]);
}

export function buildDoubaoAudioFrame(audioChunk, { isFinal = false } = {}) {
  const payload = Buffer.isBuffer(audioChunk)
    ? audioChunk
    : Buffer.from(audioChunk || []);
  const encodedPayload = gzipSync(payload);
  return Buffer.concat([
    isFinal ? DOUBAO_AUDIO_FINAL_PACKET_HEADER : DOUBAO_AUDIO_PACKET_HEADER,
    buildPayloadSizeBuffer(encodedPayload.length),
    encodedPayload,
  ]);
}

function decodeDoubaoPayload(payload, compression) {
  if (compression === 1) {
    return gunzipSync(payload).toString('utf8');
  }
  return payload.toString('utf8');
}

export function parseDoubaoServerMessage(data) {
  const bytes = Buffer.from(data);
  if (bytes.length < 8) {
    throw new Error('Doubao server message is too short');
  }
  const protocolVersion = bytes[0] >> 4;
  const headerSizeBytes = (bytes[0] & 0x0f) * 4;
  const messageType = bytes[1] >> 4;
  const flags = bytes[1] & 0x0f;
  const serialization = bytes[2] >> 4;
  const compression = bytes[2] & 0x0f;
  if (headerSizeBytes < 4 || bytes.length < headerSizeBytes + 4) {
    throw new Error('Doubao server message header is invalid');
  }

  if (messageType === 0x0f) {
    if (bytes.length < headerSizeBytes + 8) {
      throw new Error('Doubao server error message is truncated');
    }
    const errorCode = bytes.readUInt32BE(headerSizeBytes);
    const errorSize = bytes.readUInt32BE(headerSizeBytes + 4);
    const errorBytes = bytes.slice(headerSizeBytes + 8, headerSizeBytes + 8 + errorSize);
    const payload = decodeDoubaoPayload(errorBytes, compression);
    let json = null;
    try {
      json = JSON.parse(payload);
    } catch {}
    return {
      protocolVersion,
      headerSizeBytes,
      messageType,
      flags,
      serialization,
      compression,
      errorCode,
      payload,
      json,
    };
  }

  let sequence = null;
  let payloadOffset = headerSizeBytes;
  if (messageType === 0x09) {
    if (bytes.length < headerSizeBytes + 8) {
      throw new Error('Doubao server response is truncated');
    }
    sequence = bytes.readInt32BE(headerSizeBytes);
    payloadOffset += 4;
  }
  const payloadSize = bytes.readUInt32BE(payloadOffset);
  const payloadBytes = bytes.slice(payloadOffset + 4, payloadOffset + 4 + payloadSize);
  const payload = decodeDoubaoPayload(payloadBytes, compression);
  let json = null;
  try {
    json = JSON.parse(payload);
  } catch {}
  return {
    protocolVersion,
    headerSizeBytes,
    messageType,
    flags,
    sequence,
    serialization,
    compression,
    payload,
    json,
  };
}

function collectTranscriptParts(value, parts) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTranscriptParts(item, parts);
    }
    return;
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string' && value.text.trim()) {
      parts.push(value.text);
    }
    if (Array.isArray(value.result)) {
      collectTranscriptParts(value.result, parts);
    }
    if (Array.isArray(value.utterances)) {
      collectTranscriptParts(value.utterances, parts);
    }
  }
}

export function extractDoubaoTranscript(response) {
  const json = response?.json && typeof response.json === 'object'
    ? response.json
    : null;
  if (!json) return '';
  const directResultText = trimString(json?.result?.text);
  if (directResultText) {
    return directResultText;
  }
  const parts = [];
  collectTranscriptParts(json.result, parts);
  collectTranscriptParts(json.utterances, parts);
  if (parts.length === 0 && typeof json.text === 'string' && json.text.trim()) {
    parts.push(json.text);
  }
  return parts.join('').trim();
}

function getDoubaoErrorMessage(response) {
  const jsonMessage = trimString(
    response?.json?.message
    || response?.json?.msg
    || response?.json?.error,
  );
  if (jsonMessage) return jsonMessage;
  const payload = getJsonString(response?.payload);
  return payload || 'Doubao voice relay failed';
}

function getDoubaoHandshakeError(response, statusCode) {
  const fallbackMessage = `Doubao voice relay handshake failed (${statusCode || 'unknown'})`;
  const body = getJsonString(response);
  if (!body) {
    return {
      code: statusCode ? String(statusCode) : '',
      message: fallbackMessage,
    };
  }
  try {
    const json = JSON.parse(body);
    return {
      code: trimString(json?.backend_code || json?.code) || (statusCode ? String(statusCode) : ''),
      message: trimString(json?.message || json?.msg || json?.error) || body || fallbackMessage,
    };
  } catch {
    return {
      code: statusCode ? String(statusCode) : '',
      message: body || fallbackMessage,
    };
  }
}

function sendRelayEvent(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {}
}

function closeSocketQuietly(ws, code = 1000, reason = '') {
  if (!ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws.close(code, reason);
  } catch {}
}

export function bindDoubaoVoiceRelaySocket(ws) {
  const relayState = {
    connectionId: randomUUID().slice(0, 8),
    upstreamConnectId: randomUUID(),
    clientClosed: false,
    stopRequested: false,
    probeOnly: false,
    upstream: null,
    upstreamLogId: '',
    lastTranscript: '',
    sentAudio: false,
    started: false,
    readySent: false,
    upstreamClosed: false,
  };

  function getLogPrefix() {
    const role = trimString(ws?._authSession?.role) || 'owner';
    return `[voice-relay ${relayState.connectionId} role=${role}]`;
  }

  function logInfo(message, extra = '') {
    console.log(`${getLogPrefix()} ${message}${extra ? ` ${extra}` : ''}`);
  }

  function logWarn(message, extra = '') {
    console.warn(`${getLogPrefix()} ${message}${extra ? ` ${extra}` : ''}`);
  }

  function redactVoiceConfig(config) {
    return {
      appIdSuffix: trimString(config?.appId).slice(-4) || '',
      resourceId: trimString(config?.resourceId || config?.cluster),
      language: trimString(config?.language),
    };
  }

  function sendEvent(payload) {
    sendRelayEvent(ws, {
      ...payload,
      traceId: relayState.connectionId,
    });
  }

  function finishRelay({ transcript = relayState.lastTranscript, closeClient = false } = {}) {
    if (relayState.upstreamClosed) {
      if (closeClient) {
        closeSocketQuietly(ws);
      }
      return;
    }
    relayState.upstreamClosed = true;
    if (transcript) {
      logInfo('completed', `transcriptLength=${transcript.length}`);
    } else {
      logInfo('completed');
    }
    sendEvent({ type: 'done', transcript });
    if (closeClient) {
      closeSocketQuietly(ws);
    }
  }

  function failRelay(error, code = '') {
    relayState.upstreamClosed = true;
    const message = trimString(error?.message) || 'Doubao voice relay failed';
    logWarn('failed', `code=${code || trimString(error?.code) || 'unknown'} message=${message}`);
    sendEvent({
      type: 'error',
      code: code || trimString(error?.code),
      message,
      logId: relayState.upstreamLogId,
    });
    closeSocketQuietly(relayState.upstream, 1000, 'relay-error');
    closeSocketQuietly(ws, 1000, 'relay-error');
  }

  function stopUpstreamIfNeeded() {
    if (!relayState.upstream || relayState.upstream.readyState !== WebSocket.OPEN || relayState.stopRequested) {
      return;
    }
    relayState.stopRequested = true;
    logInfo('stop requested');
    sendEvent({ type: 'status', phase: 'stopping' });
    if (!relayState.sentAudio) {
      logInfo('completed without audio');
      finishRelay({ closeClient: true });
      closeSocketQuietly(relayState.upstream);
      return;
    }
    relayState.upstream.send(buildDoubaoAudioFrame(Buffer.alloc(0), { isFinal: true }));
  }

  async function startRelay(rawPayload) {
    if (relayState.upstream) {
      failRelay(new Error('Voice relay already started'));
      return;
    }
    let config;
    try {
      config = validateDoubaoVoiceConfig(await loadServerVoiceInputSettings());
    } catch (error) {
      throw new Error('Voice input is not configured for this RemoteLab instance');
    }
    relayState.probeOnly = rawPayload?.probe === true;
    const configLog = redactVoiceConfig(config);
    relayState.readySent = false;
    relayState.upstreamLogId = '';
    logInfo('start requested', `resourceId=${configLog.resourceId} language=${configLog.language} appIdSuffix=${configLog.appIdSuffix || 'none'} probeOnly=${relayState.probeOnly}`);
    sendEvent({ type: 'status', phase: 'connecting' });

    const upstream = new WebSocket(DOUBAO_VOICE_UPSTREAM_URL, {
      headers: {
        'X-Api-App-Key': config.appId,
        'X-Api-Access-Key': config.accessToken,
        'X-Api-Resource-Id': config.resourceId,
        'X-Api-Connect-Id': relayState.upstreamConnectId,
      },
      handshakeTimeout: 8000,
    });
    relayState.upstream = upstream;

    upstream.on('upgrade', (response) => {
      relayState.upstreamLogId = trimString(response?.headers?.['x-tt-logid']);
      const upstreamConnectId = trimString(response?.headers?.['x-api-connect-id']);
      logInfo(
        'upstream handshake',
        `connectId=${upstreamConnectId || relayState.upstreamConnectId} logId=${relayState.upstreamLogId || 'none'}`,
      );
    });

    upstream.on('open', () => {
      relayState.started = true;
      logInfo('upstream connected');
      upstream.send(buildDoubaoFullClientRequest(config, {
        uid: trimString(rawPayload?.uid) || 'remotelab-owner',
      }));
    });

    upstream.on('unexpected-response', (_request, response) => {
      const statusCode = Number.isInteger(response?.statusCode)
        ? response.statusCode
        : 0;
      relayState.upstreamLogId = trimString(response?.headers?.['x-tt-logid']) || relayState.upstreamLogId;
      const chunks = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || ''));
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const handshakeError = getDoubaoHandshakeError(body, statusCode);
        logWarn(
          'upstream handshake rejected',
          `statusCode=${statusCode || 'unknown'} logId=${relayState.upstreamLogId || 'none'} message=${handshakeError.message}`,
        );
        failRelay(new Error(handshakeError.message), handshakeError.code || (statusCode ? String(statusCode) : ''));
      });
      response.on('error', (error) => {
        if (relayState.upstreamClosed) return;
        failRelay(error, statusCode ? String(statusCode) : '');
      });
    });

    upstream.on('message', (data) => {
      let response;
      try {
        response = parseDoubaoServerMessage(data);
      } catch (error) {
        failRelay(error);
        return;
      }
      if (response?.errorCode) {
        failRelay(new Error(getDoubaoErrorMessage(response)), String(response.errorCode));
        return;
      }
      const responseCode = trimString(response?.json?.code);
      if (responseCode && responseCode !== '20000000') {
        failRelay(new Error(getDoubaoErrorMessage(response)), responseCode);
        return;
      }
      if (!relayState.readySent) {
        relayState.readySent = true;
        if (!relayState.probeOnly) {
          sendEvent({
            type: 'status',
            phase: 'ready',
            logId: relayState.upstreamLogId,
          });
        }
      }
      const transcript = extractDoubaoTranscript(response);
      if (transcript) {
        relayState.lastTranscript = transcript;
        sendEvent({
          type: 'transcript',
          transcript,
          logId: relayState.upstreamLogId,
        });
      }
      if (relayState.probeOnly) {
        finishRelay({ closeClient: true });
        return;
      }
      if (relayState.stopRequested && Number.isInteger(response?.sequence) && response.sequence < 0) {
        finishRelay({
          transcript: transcript || relayState.lastTranscript,
          closeClient: true,
        });
      }
    });

    upstream.on('close', (closeCode, closeReason) => {
      logInfo(
        'upstream closed',
        `code=${closeCode} reason=${String(closeReason || '')} logId=${relayState.upstreamLogId || 'none'}`,
      );
      finishRelay({ closeClient: true });
    });

    upstream.on('error', (error) => {
      if (relayState.upstreamClosed) return;
      logWarn('upstream socket error', trimString(error?.message));
      failRelay(error);
    });
  }

  ws.on('message', async (data, isBinary) => {
    if (!relayState.upstreamClosed && !isBinary) {
      let payload = null;
      try {
        payload = JSON.parse(String(data || ''));
      } catch {
        failRelay(new Error('Voice relay control payload must be valid JSON'));
        return;
      }
      if (payload?.type === 'start') {
        try {
          await startRelay(payload);
        } catch (error) {
          failRelay(error);
        }
        return;
      }
      if (payload?.type === 'stop') {
        stopUpstreamIfNeeded();
        return;
      }
      failRelay(new Error('Unsupported voice relay control message'));
      return;
    }

    if (!relayState.upstream || relayState.upstream.readyState !== WebSocket.OPEN) {
      return;
    }
    if (relayState.stopRequested || relayState.probeOnly) {
      return;
    }
    relayState.sentAudio = true;
    relayState.upstream.send(buildDoubaoAudioFrame(Buffer.from(data)));
  });

  ws.on('close', () => {
    relayState.clientClosed = true;
    logInfo('client closed');
    stopUpstreamIfNeeded();
    closeSocketQuietly(relayState.upstream);
  });
}
