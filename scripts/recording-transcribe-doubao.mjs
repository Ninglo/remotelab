// Server-side transcription of the recorder's original mono 16 kHz PCM WAV.
// Uses the instance's existing voice credentials; never installs a local model.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { loadServerVoiceInputSettings } from '../chat/instance-settings.mjs';
import { validateDoubaoVoiceConfig, buildDoubaoFullClientRequest, buildDoubaoAudioFrame,
  parseDoubaoServerMessage, extractDoubaoTranscript } from '../chat/voice-doubao-relay.mjs';

// Finished recordings need a final result, rather than the live dictation stream.
const RECORDING_UPSTREAM_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function readRecordingPcm(wav) {
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
  return pcm;
}

export async function transcribeOriginalRecording({ file, outputDir, voiceConfig,
  upstreamUrl = RECORDING_UPSTREAM_URL, deadlineMs = 120000 }) {
  const input = path.resolve(file), output = path.resolve(outputDir);
  const wav = await fs.readFile(input);
  const pcm = readRecordingPcm(wav);
  const config = validateDoubaoVoiceConfig(voiceConfig);
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const responses = [];
  let transcript = '', logId = '', sent = false, settled = false;
  const receipt = { provider: 'doubao', resourceId: config.resourceId, input,
    upstreamUrl, originalSha256: sha256(wav), sentPcmBytes: 0, finalPacketSent: false,
    finalResponseReceived: false,
    startedAt: new Date().toISOString(), durationSeconds: pcm.length / 32000,
    originalUnmodified: true, localModelUsed: false };
  const outcome = await new Promise(resolve => {
    const requestId = randomUUID();
    const ws = new WebSocket(upstreamUrl, {
      headers: { 'X-Api-App-Key': config.appId, 'X-Api-Access-Key': config.accessToken,
        'X-Api-Resource-Id': config.resourceId, 'X-Api-Request-Id': requestId,
        'X-Api-Connect-Id': requestId }, handshakeTimeout: 8000,
    });
    const timer = setTimeout(() => finish({ state: 'failed', error: 'Remote transcription deadline exceeded' }), deadlineMs);
    function finish(result) {
      if (settled) return;
      settled = true; clearTimeout(timer); ws.terminate(); resolve(result);
    }
    function sendAudio(offset = 0) {
      if (settled) return;
      const end = Math.min(offset + 6400, pcm.length);
      receipt.sentPcmBytes += end - offset;
      receipt.finalPacketSent = end === pcm.length;
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
        if (code && String(code) !== '20000000') return finish({ state: 'failed', code, error: response.json?.message || response.json?.msg || response.json?.error || response.payload || 'Upstream transcription rejected' });
        const text = extractDoubaoTranscript(response);
        if (text) transcript = text;
        if ((response.flags & 2) !== 0 && response.json) {
          receipt.finalResponseReceived = true;
          receipt.recognizedDurationMs = response.json.audio_info?.duration;
          // Preserve partial text on failure, but never report it as a full transcript.
          if (!receipt.finalPacketSent || receipt.sentPcmBytes !== pcm.length ||
            !Number.isFinite(receipt.recognizedDurationMs) ||
            Math.abs(receipt.recognizedDurationMs - receipt.durationSeconds * 1000) > 1) {
            return finish({ state: 'failed', error: 'Final recognition did not cover the complete recording' });
          }
          transcript = text;
          return finish({ state: 'completed' });
        }
        if (!sent) { sent = true; sendAudio(); }
      } catch (error) { finish({ state: 'failed', error: error.message }); }
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume(); finish({ state: 'failed', httpStatus: response.statusCode, error: 'Remote transcription HTTP rejection' });
    });
    ws.on('error', error => finish({ state: 'failed', error: error.message }));
    ws.on('close', code => finish({ state: 'failed', closeCode: code, error: 'Upstream closed before final result' }));
  });
  Object.assign(receipt, outcome, { logId, finishedAt: new Date().toISOString() });
  if (sha256(await fs.readFile(input)) !== receipt.originalSha256) {
    Object.assign(receipt, { state: 'failed', originalUnmodified: false, error: 'Original recording changed during transcription' });
  }
  receipt.transcriptState = receipt.state === 'completed' ? 'final' : transcript ? 'partial' : 'empty';
  receipt.hasSpeech = Boolean(transcript);
  await fs.writeFile(path.join(output, 'remote-response.json'), JSON.stringify({ receipt, responses }, null, 2) + '\n', { mode: 0o600 });
  await fs.writeFile(path.join(output, 'transcript.raw.txt'), transcript, { mode: 0o600 });
  return { ...receipt, output };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/recording-transcribe-doubao.mjs --file <original.wav> --output-dir <source-directory>\nRun on the RemoteLab analysis instance. Requires its existing Doubao voice configuration. Saves raw response, transcript and a receipt; preserves the input. Completed requires a final response covering all audio; empty speech is reported separately.');
    return;
  }
  const option = name => args[args.indexOf(name) + 1];
  if (!args.includes('--file') || !args.includes('--output-dir')) throw Error('Both --file and --output-dir are required; use --help');
  const receipt = await transcribeOriginalRecording({ file: option('--file'),
    outputDir: option('--output-dir'), voiceConfig: await loadServerVoiceInputSettings() });
  console.log(JSON.stringify(receipt));
  if (receipt.state !== 'completed') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
