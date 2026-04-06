import { createWriteStream } from 'fs';
import { join } from 'path';
import { ANALYTICS_LOGS_DIR } from '../lib/config.mjs';
import { ensureDir } from './fs-utils.mjs';

let currentDateKey = '';
let currentStream = null;
let loggingDisabled = false;

function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function disableLogging(error) {
  if (loggingDisabled) return;
  loggingDisabled = true;
  currentDateKey = '';
  if (currentStream) {
    currentStream.destroy();
    currentStream = null;
  }
  console.error(`[analytics-log] Disabled analytics logging: ${error?.message || error}`);
}

function ensureStream(now = new Date()) {
  if (loggingDisabled) return null;
  const dateKey = formatDateKey(now);
  if (currentStream && currentDateKey === dateKey) {
    return currentStream;
  }
  try {
    const nextPath = join(ANALYTICS_LOGS_DIR, `${dateKey}.jsonl`);
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

export async function initAnalyticsLog() {
  try {
    await ensureDir(ANALYTICS_LOGS_DIR);
  } catch (error) {
    disableLogging(error);
  }
}

export function writeAnalyticsEvents(events, serverContext) {
  const now = new Date();
  const stream = ensureStream(now);
  if (!stream) return;

  const { ip, userAgent, role } = serverContext;
  const ts = now.toISOString();

  for (const event of events) {
    const record = {
      ts,
      clientTs: event.clientTs || null,
      ip: ip || 'unknown',
      ua: userAgent || '',
      role: role || 'unknown',
      cid: event.cid || '',
      sid: event.sid || '',
      event: event.event || 'unknown',
      cat: event.cat || 'interaction',
      props: event.props || {},
    };
    stream.write(`${JSON.stringify(record)}\n`);
  }
}

export function closeAnalyticsLog() {
  if (!currentStream) return Promise.resolve();
  const stream = currentStream;
  currentStream = null;
  currentDateKey = '';
  return new Promise((resolve) => {
    stream.end(resolve);
  });
}
