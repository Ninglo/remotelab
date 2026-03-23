import { createWriteStream } from 'fs';
import { join } from 'path';
import { parse as parseUrl } from 'url';
import { API_REQUEST_LOGS_DIR, CHAT_PORT } from '../lib/config.mjs';
import { parseSessionGetRoute } from './session-route-utils.mjs';
import { ensureDir } from './fs-utils.mjs';

let currentDateKey = '';
let currentStream = null;
let loggingDisabled = false;
let nextRequestSeq = 0;

function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function safeHeaderValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function bytesForChunk(chunk, encoding) {
  if (chunk == null) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined);
  return Buffer.byteLength(String(chunk));
}

function truncate(value, maxLength = 512) {
  const text = typeof value === 'string' ? value : String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function disableLogging(error) {
  if (loggingDisabled) return;
  loggingDisabled = true;
  currentDateKey = '';
  if (currentStream) {
    currentStream.destroy();
    currentStream = null;
  }
  console.error(`[api-log] Disabled API request logging: ${error?.message || error}`);
}

function ensureStream(now = new Date()) {
  if (loggingDisabled) return null;
  const dateKey = formatDateKey(now);
  if (currentStream && currentDateKey === dateKey) {
    return currentStream;
  }
  try {
    const nextPath = join(API_REQUEST_LOGS_DIR, `${dateKey}.jsonl`);
    const nextStream = createWriteStream(nextPath, { flags: 'a', encoding: 'utf8' });
    nextStream.on('error', disableLogging);
    if (currentStream) {
      currentStream.end();
    }
    currentStream = nextStream;
    currentDateKey = dateKey;
    return currentStream;
  } catch (error) {
    disableLogging(error);
    return null;
  }
}

export async function initApiRequestLog() {
  try {
    await ensureDir(API_REQUEST_LOGS_DIR);
  } catch (error) {
    disableLogging(error);
  }
}

function writeRecord(record, timestamp = new Date()) {
  const stream = ensureStream(timestamp);
  if (!stream) return;
  stream.write(`${JSON.stringify(record)}\n`);
}

function classifyApiRoute(method, pathname) {
  const sessionGetRoute = method === 'GET' ? parseSessionGetRoute(pathname) : null;
  if (sessionGetRoute) {
    if (sessionGetRoute.kind === 'list') return 'GET /api/sessions';
    if (sessionGetRoute.kind === 'archived-list') return 'GET /api/sessions/archived';
    if (sessionGetRoute.kind === 'detail') return 'GET /api/sessions/:sessionId';
    if (sessionGetRoute.kind === 'events') return 'GET /api/sessions/:sessionId/events';
    if (sessionGetRoute.kind === 'event-block') return 'GET /api/sessions/:sessionId/events/blocks/:startSeq-:endSeq';
    if (sessionGetRoute.kind === 'event-body') return 'GET /api/sessions/:sessionId/events/:seq/body';
  }

  if (pathname === '/api/auth/me' && method === 'GET') return 'GET /api/auth/me';
  if (pathname === '/api/models' && method === 'GET') return 'GET /api/models';
  if (pathname === '/api/tools' && method === 'GET') return 'GET /api/tools';
  if (pathname === '/api/tools' && method === 'POST') return 'POST /api/tools';
  if (pathname === '/api/autocomplete' && method === 'GET') return 'GET /api/autocomplete';
  if (pathname === '/api/browse' && method === 'GET') return 'GET /api/browse';
  if (pathname === '/api/push/vapid-public-key' && method === 'GET') return 'GET /api/push/vapid-public-key';
  if (pathname === '/api/push/subscribe' && method === 'POST') return 'POST /api/push/subscribe';
  if (pathname === '/api/apps' && method === 'GET') return 'GET /api/apps';
  if (pathname === '/api/apps' && method === 'POST') return 'POST /api/apps';
  if (pathname === '/api/runtime-selection' && method === 'POST') return 'POST /api/runtime-selection';
  if (pathname.startsWith('/api/apps/') && method === 'PATCH') return 'PATCH /api/apps/:appId';
  if (pathname.startsWith('/api/apps/') && method === 'DELETE') return 'DELETE /api/apps/:appId';
  if (pathname.startsWith('/api/images/') && method === 'GET') return 'GET /api/images/:imageName';
  if (pathname.startsWith('/api/media/') && method === 'GET') return 'GET /api/media/:mediaName';
  if (pathname === '/api/sessions' && method === 'POST') return 'POST /api/sessions';

  if (pathname.startsWith('/api/sessions/')) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] === 'api' && parts[1] === 'sessions') {
      if (parts.length === 3 && method === 'PATCH') return 'PATCH /api/sessions/:sessionId';
      if (parts.length === 4 && method === 'POST') {
        if (parts[3] === 'messages') return 'POST /api/sessions/:sessionId/messages';
        if (parts[3] === 'cancel') return 'POST /api/sessions/:sessionId/cancel';
        if (parts[3] === 'compact') return 'POST /api/sessions/:sessionId/compact';
        if (parts[3] === 'drop-tools') return 'POST /api/sessions/:sessionId/drop-tools';
        if (parts[3] === 'fork') return 'POST /api/sessions/:sessionId/fork';
        if (parts[3] === 'delegate') return 'POST /api/sessions/:sessionId/delegate';
        if (parts[3] === 'share') return 'POST /api/sessions/:sessionId/share';
      }
    }
  }

  if (pathname.startsWith('/api/runs/')) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'runs' && method === 'GET') {
      return 'GET /api/runs/:runId';
    }
    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'cancel' && method === 'POST') {
      return 'POST /api/runs/:runId/cancel';
    }
  }

  return `${method} ${pathname}`;
}

function isApiRequest(req) {
  const pathname = parseUrl(req.url || '').pathname || '';
  return pathname.startsWith('/api/');
}

function requestBytes(req) {
  const header = req.headers['content-length'];
  const parsed = Number.parseInt(Array.isArray(header) ? header[0] : header || '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    message: truncate(error.message || String(error), 300),
    code: error.code || null,
  };
}

export function startApiRequestLog(req, res) {
  if (!isApiRequest(req)) {
    return { markError() {} };
  }

  const requestSeq = ++nextRequestSeq;
  const parsedUrl = parseUrl(req.url || '', true);
  const pathname = parsedUrl.pathname || '';
  const search = parsedUrl.search || '';
  const startedAt = new Date();
  const startedHr = process.hrtime.bigint();
  const bodyBytes = requestBytes(req);

  let responseBytes = 0;
  let responseStartedHr = null;
  let error = null;
  let finished = false;

  const originalWriteHead = res.writeHead.bind(res);
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  function markResponseStart() {
    if (responseStartedHr === null) {
      responseStartedHr = process.hrtime.bigint();
    }
  }

  res.writeHead = function patchedWriteHead(...args) {
    markResponseStart();
    return originalWriteHead(...args);
  };

  res.write = function patchedWrite(chunk, encoding, callback) {
    markResponseStart();
    responseBytes += bytesForChunk(chunk, encoding);
    return originalWrite(chunk, encoding, callback);
  };

  res.end = function patchedEnd(chunk, encoding, callback) {
    markResponseStart();
    responseBytes += bytesForChunk(chunk, encoding);
    return originalEnd(chunk, encoding, callback);
  };

  function flush(aborted) {
    if (finished) return;
    finished = true;
    const finishedHr = process.hrtime.bigint();
    const durationMs = roundMs(Number(finishedHr - startedHr) / 1e6);
    const responseStartMs = responseStartedHr === null ? null : roundMs(Number(responseStartedHr - startedHr) / 1e6);
    writeRecord({
      type: 'api_request',
      seq: requestSeq,
      pid: process.pid,
      port: CHAT_PORT,
      ts: startedAt.toISOString(),
      method: req.method || 'GET',
      pathname,
      route: classifyApiRoute(req.method || 'GET', pathname),
      search: search ? truncate(search, 512) : '',
      queryKeys: Object.keys(parsedUrl.query || {}).sort(),
      requestBytes: bodyBytes,
      responseBytes,
      statusCode: res.statusCode,
      responseStartMs,
      durationMs,
      cacheHit: res.statusCode === 304,
      contentType: truncate(safeHeaderValue(res.getHeader('Content-Type')), 120),
      cacheControl: truncate(safeHeaderValue(res.getHeader('Cache-Control')), 120),
      aborted,
      error: serializeError(error),
    }, startedAt);
  }

  res.once('finish', () => flush(false));
  res.once('close', () => {
    if (!res.writableFinished) {
      flush(true);
    }
  });

  return {
    markError(value) {
      error = value;
    },
  };
}

export function closeApiRequestLog() {
  if (!currentStream) return Promise.resolve();
  const stream = currentStream;
  currentStream = null;
  currentDateKey = '';
  return new Promise((resolve) => {
    stream.end(resolve);
  });
}
