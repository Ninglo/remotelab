import { setIsolatedTestHome } from './isolate-test-environment.mjs';

import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-transcription-home-'));
setIsolatedTestHome(testHome);
after(() => fs.rm(testHome, { recursive: true, force: true }));
const { transcribeOriginalRecording } = await import('../scripts/recording-transcribe-doubao.mjs');

const config = { appId: 'test-app', accessToken: 'test-token', resourceId: 'test-resource' };
function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function response(json, flags = 0, errorCode = 0) {
  const payload = Buffer.from(JSON.stringify(json));
  const header = Buffer.from([0x11, (errorCode ? 0xf0 : 0x90) | flags, 0x10, 0]);
  const size = Buffer.alloc(4); size.writeUInt32BE(payload.length);
  if (!errorCode) return Buffer.concat([header, size, payload]);
  const code = Buffer.alloc(4); code.writeUInt32BE(errorCode);
  return Buffer.concat([header, code, size, payload]);
}
async function scenario(t, finish) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-transcription-'));
  const original = wav(Buffer.alloc(32000 * 72 + 308, 17));
  const file = path.join(directory, 'original.wav');
  await fs.writeFile(file, original);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const chunks = [];
  server.on('connection', (socket, request) => {
    assert.ok(request.headers['x-api-request-id']);
    socket.on('message', data => {
      const frame = Buffer.from(data);
      if (frame[1] === 0x10) {
        const full = JSON.parse(gunzipSync(frame.subarray(8)));
        assert.equal(full.request.enable_ddc, undefined);
        socket.send(response({ audio_info: { duration: 0 }, result: { text: '' } }));
      } else {
        chunks.push(gunzipSync(frame.subarray(8)));
        if ((frame[1] & 2) !== 0) finish(socket, original.length - 44);
      }
    });
  });
  const outputDir = path.join(directory, 'result');
  const receipt = await transcribeOriginalRecording({ file, outputDir, voiceConfig: config,
    upstreamUrl: `ws://127.0.0.1:${server.address().port}`, deadlineMs: 3000 });
  assert.deepEqual(await fs.readFile(file), original, 'recognition must preserve original bytes');
  assert.deepEqual(Buffer.concat(chunks), original.subarray(44), 'all audio, including the last partial packet, must arrive');
  return { receipt, text: await fs.readFile(path.join(outputDir, 'transcript.raw.txt'), 'utf8') };
}

test('a 72-second file completes only after an explicit final result covering all audio', async t => {
  const { receipt, text } = await scenario(t, (socket, bytes) => {
    socket.send(response({ audio_info: { duration: 32000 }, result: { text: '前半段' } }));
    socket.send(response({ audio_info: { duration: Math.floor(bytes / 32) }, result: { text: '前半段和录音末尾' } }, 2));
  });
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.finalResponseReceived, true);
  assert.equal(receipt.originalUnmodified, true);
  assert.equal(receipt.transcriptState, 'final');
  assert.equal(text, '前半段和录音末尾');
});

test('a socket close after partial text cannot pass as completed', async t => {
  const { receipt, text } = await scenario(t, socket => {
    socket.send(response({ audio_info: { duration: 32000 }, result: { text: '只有前半段' } }));
    socket.close();
  });
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.transcriptState, 'partial');
  assert.equal(text, '只有前半段');
});

test('a final result covering only half the recording must fail', async t => {
  const { receipt } = await scenario(t, socket => {
    socket.send(response({ audio_info: { duration: 32000 }, result: { text: '不完整' } }, 2));
  });
  assert.equal(receipt.state, 'failed');
  assert.match(receipt.error, /complete recording/);
});

test('provider timeout reason and partial text are retained', async t => {
  const { receipt, text } = await scenario(t, socket => {
    socket.send(response({ result: { text: '未收尾' } }));
    socket.send(response({ error: 'Timed out waiting for the next audio packet' }, 0, 45000081));
  });
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.code, 45000081);
  assert.match(receipt.error, /Timed out waiting/);
  assert.equal(text, '未收尾');
});

test('a final empty result is marked as no speech, without retaining interim text', async t => {
  const { receipt, text } = await scenario(t, (socket, bytes) => {
    socket.send(response({ result: { text: '临时文字' } }));
    socket.send(response({ audio_info: { duration: Math.floor(bytes / 32) }, result: { text: '' } }, 2));
  });
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.hasSpeech, false);
  assert.equal(text, '');
});
