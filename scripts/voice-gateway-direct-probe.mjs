#!/usr/bin/env node
import { WebSocket } from 'ws';

const DEFAULT_GATEWAY_BASE_URL = 'wss://ai-gateway.vei.volces.com/v1/realtime';
const DEFAULT_MODEL = 'bigmodel';
const DEFAULT_SUBPROTOCOLS = Object.freeze([
  'realtime',
  'openai-insecure-api-key.%API_KEY%',
  'openai-beta.realtime-v1',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printUsage() {
  console.log(`Usage:
  node scripts/voice-gateway-direct-probe.mjs [options]

Options:
  --api-key <key>          Real gateway API key. When omitted, the probe uses a dummy key.
  --resource-id <id>       Optional X-Api-Resource-Id header for the header-auth scenario.
  --model <name>           Realtime model query parameter. Default: ${DEFAULT_MODEL}
  --base-url <url>         Realtime base URL. Default: ${DEFAULT_GATEWAY_BASE_URL}
  --json                   Emit JSON only.
  --help                   Show this help.

What this probe does:
  1. Connects to the Volcengine Realtime gateway.
  2. Tries the auth shape that RemoteLab can already do from Node (Authorization header).
  3. Tries the inferred browser-only auth shape (Sec-WebSocket-Protocol subprotocols).
  4. On a successful open, sends transcription_session.update and waits for the first server event.

Notes:
  - The subprotocol auth shape is inferred from Volcengine's docs saying browser JS should
    follow the OpenAI-style Sec-WebSocket-Protocol pattern for Realtime websocket auth.
  - If you do not provide a real API key, a 401 invalid-key response only proves that the
    gateway path is reachable. It does not fully prove browser auth compatibility for Doubao-ASR.
`);
}

function parseArgs(argv) {
  const options = {
    apiKey: '',
    resourceId: '',
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_GATEWAY_BASE_URL,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--api-key':
        options.apiKey = trimString(argv[index + 1]);
        index += 1;
        break;
      case '--resource-id':
        options.resourceId = trimString(argv[index + 1]);
        index += 1;
        break;
      case '--model':
        options.model = trimString(argv[index + 1]) || DEFAULT_MODEL;
        index += 1;
        break;
      case '--base-url':
        options.baseUrl = trimString(argv[index + 1]) || DEFAULT_GATEWAY_BASE_URL;
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function buildTargetUrl(baseUrl, model) {
  const url = new URL(baseUrl);
  url.searchParams.set('model', model);
  return url.toString();
}

function buildTranscriptionSessionUpdate(model) {
  return JSON.stringify({
    type: 'transcription_session.update',
    session: {
      input_audio_format: 'pcm',
      input_audio_codec: 'raw',
      input_audio_sample_rate: 16000,
      input_audio_bits: 16,
      input_audio_channel: 1,
      result_type: 0,
      turn_detection: null,
      input_audio_transcription: {
        model,
      },
    },
  });
}

function buildBrowserAuthSubprotocols(apiKey) {
  return DEFAULT_SUBPROTOCOLS.map((entry) => entry.replace('%API_KEY%', apiKey));
}

function summarizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => ['content-type', 'x-tt-logid', 'upstream-caught', 'sec-websocket-protocol'].includes(String(key).toLowerCase()))
      .map(([key, value]) => [key, value]),
  );
}

function createScenarios(targetUrl, model, apiKey, resourceId) {
  const effectiveKey = apiKey || 'dummy-key';
  const sessionUpdate = buildTranscriptionSessionUpdate(model);
  const baseHeaders = {};
  if (resourceId) {
    baseHeaders['X-Api-Resource-Id'] = resourceId;
  }

  return [
    {
      name: apiKey ? 'header-auth-real-key' : 'header-auth-dummy-key',
      connect() {
        return new WebSocket(targetUrl, {
          headers: {
            Authorization: `Bearer ${effectiveKey}`,
            ...baseHeaders,
          },
          handshakeTimeout: 10000,
        });
      },
      sessionUpdate,
    },
    {
      name: apiKey ? 'subprotocol-auth-real-key' : 'subprotocol-auth-dummy-key',
      connect() {
        return new WebSocket(targetUrl, buildBrowserAuthSubprotocols(effectiveKey), {
          handshakeTimeout: 10000,
        });
      },
      sessionUpdate,
    },
  ];
}

function runScenario(scenario) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const ws = scenario.connect();
    let settled = false;
    let firstMessageSeen = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve({
        name: scenario.name,
        elapsedMs: Date.now() - startedAt,
        ...result,
      });
    };

    ws.on('open', () => {
      try {
        ws.send(scenario.sessionUpdate);
      } catch (error) {
        done({
          outcome: 'send-failed',
          error: error.message,
        });
      }
    });

    ws.on('message', (data) => {
      const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {}
      firstMessageSeen = true;
      done({
        outcome: 'message',
        messageType: trimString(json?.type),
        messageCode: trimString(json?.error?.code) || trimString(json?.code),
        messageSummary: json || raw.slice(0, 1200),
      });
    });

    ws.on('unexpected-response', (_request, response) => {
      const chunks = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || ''));
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {}
        done({
          outcome: 'unexpected-response',
          statusCode: response.statusCode || 0,
          headers: summarizeHeaders(response.headers),
          body: json || body.slice(0, 1200),
        });
      });
      response.on('error', (error) => {
        done({
          outcome: 'response-error',
          error: error.message,
        });
      });
    });

    ws.on('error', (error) => {
      done({
        outcome: 'error',
        error: error.message,
      });
    });

    ws.on('close', (code, reason) => {
      if (firstMessageSeen) return;
      done({
        outcome: 'close',
        closeCode: code,
        closeReason: String(reason || ''),
      });
    });

    setTimeout(() => {
      done({
        outcome: 'timeout',
      });
    }, 12000);
  });
}

function renderReadableSummary(options, results) {
  const lines = [];
  lines.push(`Target: ${buildTargetUrl(options.baseUrl, options.model)}`);
  lines.push(`Mode: ${options.apiKey ? 'real API key provided' : 'dummy API key only'}`);
  if (options.resourceId) {
    lines.push(`Header-only resource id: ${options.resourceId}`);
  }
  lines.push('');

  for (const result of results) {
    lines.push(`${result.name}`);
    lines.push(`  outcome: ${result.outcome}`);
    if (result.statusCode) lines.push(`  status: ${result.statusCode}`);
    if (result.messageType) lines.push(`  messageType: ${result.messageType}`);
    if (result.messageCode) lines.push(`  messageCode: ${result.messageCode}`);
    if (result.closeCode) lines.push(`  closeCode: ${result.closeCode}`);
    if (result.closeReason) lines.push(`  closeReason: ${result.closeReason}`);
    if (result.error) lines.push(`  error: ${result.error}`);
    if (result.headers && Object.keys(result.headers).length > 0) {
      lines.push(`  headers: ${JSON.stringify(result.headers)}`);
    }
    if (result.body) {
      lines.push(`  body: ${JSON.stringify(result.body)}`);
    }
    if (result.messageSummary) {
      lines.push(`  message: ${JSON.stringify(result.messageSummary)}`);
    }
    lines.push('');
  }

  if (!options.apiKey) {
    lines.push('Interpretation:');
    lines.push('  Without a real API key, this probe can confirm reachability and the server-side auth error surface.');
    lines.push('  It cannot fully prove that the inferred browser subprotocol auth is accepted for Doubao-ASR.');
  }

  return lines.join('\n').trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const targetUrl = buildTargetUrl(options.baseUrl, options.model);
  const scenarios = createScenarios(targetUrl, options.model, options.apiKey, options.resourceId);
  const results = [];

  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }

  if (options.json) {
    console.log(JSON.stringify({
      targetUrl,
      apiKeyProvided: !!options.apiKey,
      resourceIdProvided: !!options.resourceId,
      results,
    }, null, 2));
    return;
  }

  console.log(renderReadableSummary(options, results));
}

try {
  await main();
} catch (error) {
  console.error(error?.message || error);
  process.exitCode = 1;
}
