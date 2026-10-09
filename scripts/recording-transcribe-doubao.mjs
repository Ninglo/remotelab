// Server-side transcription of the recorder's original mono 16 kHz PCM WAV.
// Uses the instance's existing voice credentials; never installs a local model.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { loadServerVoiceInputSettings } from '../chat/instance-settings.mjs';
import { validateDoubaoVoiceConfig, buildDoubaoFullClientRequest, buildDoubaoAudioFrame,
  parseDoubaoServerMessage, extractDoubaoTranscript } from '../chat/voice-doubao-relay.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/recording-transcribe-doubao.mjs --file <original.wav> --output-dir <source-directory>\nRun on the RemoteLab analysis instance. Requires its existing Doubao voice configuration. Saves raw response, transcript and a receipt; preserves the input.');
  process.exit(0);
}
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--file') || !args.includes('--output-dir')) throw Error('Both --file and --output-dir are required; use --help');
const input = path.resolve(option('--file')), output = path.resolve(option('--output-dir'));
const wav = await fs.readFile(input);
if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw Error('Expected an original PCM WAV recording');
let format, pcm;
for (let offset = 12; offset + 8 <= wav.length;) {
  const size = wav.readUInt32LE(offset + 4), start = offset + 8;
  if (start + size > wav.length) throw Error('Truncated WAV chunk');
  const type = wav.toString('ascii', offset, offset + 4);
  if (type === 'fmt ' && size >= 16) format = wav.subarray(start, start + size);
  if (type === 'data') pcm = wav.subarray(start, start + size);
  offset = start + size + (size % 2);
}
if (!format || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 16000 || format.readUInt16LE(14) !== 16 || !pcm?.length || pcm.length % 2) throw Error('Expected mono 16 kHz PCM16 WAV; do not change the original to fit this helper');
const config = validateDoubaoVoiceConfig(await loadServerVoiceInputSettings());
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const responses = [];
let transcript = '', logId = '', sent = false, settled = false;
const receipt = { provider: 'doubao', resourceId: config.resourceId, input,
  startedAt: new Date().toISOString(), durationSeconds: pcm.length / 32000,
  originalUnmodified: true, localModelUsed: false };
const outcome = await new Promise(resolve => {
  const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', {
    headers: { 'X-Api-App-Key': config.appId, 'X-Api-Access-Key': config.accessToken,
      'X-Api-Resource-Id': config.resourceId, 'X-Api-Connect-Id': randomUUID() }, handshakeTimeout: 8000,
  });
  const timer = setTimeout(() => finish({ state: 'failed', error: 'Remote transcription deadline exceeded' }), 120000);
  function finish(result) {
    if (settled) return;
    settled = true; clearTimeout(timer); ws.terminate(); resolve(result);
  }
  function sendAudio(offset = 0) {
    if (settled) return;
    const end = Math.min(offset + 6400, pcm.length);
    ws.send(buildDoubaoAudioFrame(pcm.subarray(offset, end), { isFinal: end === pcm.length }), error => {
      if (error) finish({ state: 'failed', error: error.message });
      else if (end < pcm.length) sendAudio(end);
    });
  }
  ws.on('upgrade', response => { logId = String(response.headers['x-tt-logid'] || ''); });
  ws.on('open', () => ws.send(buildDoubaoFullClientRequest(config, { uid: 'remotelab-recording-source', organize: false, smooth: false })));
  ws.on('message', data => {
    try {
      const response = parseDoubaoServerMessage(data); responses.push(response);
      const code = response.errorCode || response.json?.code;
      if (code && String(code) !== '20000000') return finish({ state: 'failed', code, error: response.json?.message || response.json?.msg || 'Upstream transcription rejected' });
      const text = extractDoubaoTranscript(response);
      if (text) transcript = text;
      if (!sent) { sent = true; sendAudio(); }
      if ((response.flags & 2) !== 0 && response.json) finish({ state: 'completed' });
    } catch (error) { finish({ state: 'failed', error: error.message }); }
  });
  ws.on('unexpected-response', (_request, response) => {
    response.resume(); finish({ state: 'failed', httpStatus: response.statusCode, error: 'Remote transcription HTTP rejection' });
  });
  ws.on('error', error => finish({ state: 'failed', error: error.message }));
  ws.on('close', code => finish({ state: 'failed', closeCode: code, error: 'Upstream closed before final result' }));
});
Object.assign(receipt, outcome, { logId, finishedAt: new Date().toISOString() });
await fs.writeFile(path.join(output, 'remote-response.json'), JSON.stringify({ receipt, responses }, null, 2) + '\n', { mode: 0o600 });
await fs.writeFile(path.join(output, 'transcript.raw.txt'), transcript, { mode: 0o600 });
console.log(JSON.stringify({ ...receipt, output }));
if (receipt.state !== 'completed') process.exitCode = 1;
