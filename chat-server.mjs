#!/usr/bin/env node
import http from 'http';
import { CHAT_PORT, CHAT_HOST, SECURE_COOKIES, MEMORY_DIR } from './lib/config.mjs';
import { handleRequest } from './chat/router.mjs';
import { closeApiRequestLog, initApiRequestLog, startApiRequestLog } from './chat/api-request-log.mjs';
import { attachWebSocket } from './chat/ws.mjs';
import { killAll, startDetachedRunObservers } from './chat/session-manager.mjs';
import { join } from 'path';
import { ensureDir } from './chat/fs-utils.mjs';

// Ensure memory directory structure exists
for (const dir of [MEMORY_DIR, join(MEMORY_DIR, 'tasks')]) {
  await ensureDir(dir);
}

await initApiRequestLog();

const server = http.createServer((req, res) => {
  const requestLog = startApiRequestLog(req, res);
  handleRequest(req, res).catch(err => {
    requestLog.markError(err);
    console.error('Unhandled request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
});

attachWebSocket(server);
try {
  await startDetachedRunObservers();
} catch (error) {
  console.error('Failed to rehydrate detached runs on startup:', error);
}

async function shutdown() {
  console.log('Shutting down chat server...');
  await closeApiRequestLog();
  killAll();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(CHAT_PORT, CHAT_HOST, () => {
  console.log(`Chat server listening on http://${CHAT_HOST}:${CHAT_PORT}`);
  console.log(`Cookie mode: ${SECURE_COOKIES ? 'Secure (HTTPS)' : 'Non-secure (localhost)'}`);
});
