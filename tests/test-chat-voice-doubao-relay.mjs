#!/usr/bin/env node
import assert from 'assert/strict';
import { gunzipSync, gzipSync } from 'zlib';

import {
  buildDoubaoAudioFrame,
  buildDoubaoFullClientRequest,
  extractDoubaoTranscript,
  normalizeDoubaoVoiceConfig,
  parseDoubaoServerMessage,
} from '../chat/voice-doubao-relay.mjs';

const normalized = normalizeDoubaoVoiceConfig({
  appid: ' 123 ',
  token: ' token-1 ',
  cluster: ' volc.seedasr.sauc.duration ',
  language: ' en-US ',
});
assert.deepEqual(normalized, {
  provider: 'doubao',
  appId: '123',
  accessToken: 'token-1',
  resourceId: 'volc.seedasr.sauc.duration',
  cluster: 'volc.seedasr.sauc.duration',
  language: 'en-US',
});

const fullRequest = buildDoubaoFullClientRequest({
  appId: '123',
  accessToken: 'token-1',
  resourceId: 'volc.seedasr.sauc.duration',
  language: 'zh-CN',
}, { uid: 'owner-1' });
assert.equal(fullRequest[0], 0x11, 'full client request should use protocol version 1 with a 4-byte header');
assert.equal(fullRequest[1], 0x10, 'full client request should use message type 1');
assert.equal(fullRequest[2], 0x11, 'full client request should mark JSON + gzip');
const fullRequestPayload = JSON.parse(gunzipSync(fullRequest.subarray(8)).toString('utf8'));
assert.deepEqual(fullRequestPayload, {
  user: { uid: 'owner-1' },
  audio: {
    format: 'pcm',
    rate: 16000,
    bits: 16,
    channel: 1,
  },
  request: {
    model_name: 'bigmodel',
    enable_itn: true,
    enable_punc: true,
  },
}, 'full request should use the v3 bigmodel payload shape');

const audioFrame = buildDoubaoAudioFrame(Buffer.from([1, 2, 3]));
assert.equal(audioFrame[0], 0x11, 'audio frame should keep protocol version 1');
assert.equal(audioFrame[1], 0x20, 'audio frame should use the non-final audio packet type');
assert.equal(audioFrame[2], 0x01, 'audio frame should gzip-compress the PCM payload');
assert.deepEqual(
  gunzipSync(audioFrame.subarray(8)),
  Buffer.from([1, 2, 3]),
  'audio frame payload should round-trip through gzip',
);

const finalAudioFrame = buildDoubaoAudioFrame(Buffer.alloc(0), { isFinal: true });
assert.equal(finalAudioFrame[1], 0x22, 'final audio frame should set the last-packet flag');
assert.equal(finalAudioFrame[2], 0x01, 'final audio frame should keep gzip compression enabled');

const transcriptPayload = gzipSync(Buffer.from(JSON.stringify({
  code: 20000000,
  result: {
    text: '你好世界',
    utterances: [
      { text: '你好' },
      { text: '世界' },
    ],
  },
}), 'utf8'));
const transcriptSequence = Buffer.alloc(4);
transcriptSequence.writeInt32BE(1, 0);
const transcriptSize = Buffer.alloc(4);
transcriptSize.writeUInt32BE(transcriptPayload.length, 0);
const transcriptFrame = Buffer.concat([
  Buffer.from([0x11, 0x90, 0x11, 0x00]),
  transcriptSequence,
  transcriptSize,
  transcriptPayload,
]);
const parsedTranscript = parseDoubaoServerMessage(transcriptFrame);
assert.equal(parsedTranscript.messageType, 9, 'full server responses should parse as message type 9');
assert.equal(parsedTranscript.sequence, 1, 'full server responses should expose the server sequence');
assert.equal(extractDoubaoTranscript(parsedTranscript), '你好世界', 'transcript extraction should flatten result text values');

const errorPayload = gzipSync(Buffer.from(JSON.stringify({
  message: 'missing Authorization header',
  code: 401,
  backend_code: 45000010,
}), 'utf8'));
const errorCode = Buffer.alloc(4);
errorCode.writeUInt32BE(45000010, 0);
const errorSize = Buffer.alloc(4);
errorSize.writeUInt32BE(errorPayload.length, 0);
const errorFrame = Buffer.concat([
  Buffer.from([0x11, 0xf0, 0x11, 0x00]),
  errorCode,
  errorSize,
  errorPayload,
]);
const parsedError = parseDoubaoServerMessage(errorFrame);
assert.equal(parsedError.errorCode, 45000010, 'error responses should expose the backend error code');
assert.match(parsedError.payload, /missing Authorization header/, 'error payload should be decompressed JSON');

console.log('test-chat-voice-doubao-relay: ok');
