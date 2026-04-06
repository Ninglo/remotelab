#!/usr/bin/env node
import { join } from 'path';

const http = await import('http');
const [
  { CHAT_PORT, CHAT_BIND_HOST, SECURE_COOKIES, MEMORY_DIR },
  { handleRequest },
  apiRequestLog,
  usageLedger,
  ws,
  sessionManager,
  triggers,
  { ensureDir },
  embeddedMailWorker,
] = await Promise.all([
  import('./lib/config.mjs'),
  import('./chat/router.mjs'),
  import('./chat/api-request-log.mjs'),
  import('./chat/usage-ledger.mjs'),
  import('./chat/ws.mjs'),
  import('./chat/session-manager.mjs'),
  import('./chat/triggers.mjs'),
  import('./chat/fs-utils.mjs'),
  import('./lib/embedded-mail-worker.mjs'),
]);

for (const dir of [MEMORY_DIR, join(MEMORY_DIR, 'tasks')]) {
  await ensureDir(dir);
}

await apiRequestLog.initApiRequestLog();
await usageLedger.initUsageLedger();

const server = http.createServer((req, res) => {
  const requestLog = apiRequestLog.startApiRequestLog(req, res);
  handleRequest(req, res).catch(err => {
    requestLog.markError(err);
    console.error('Unhandled request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
});

ws.attachWebSocket(server);
triggers.startTriggerScheduler();
void (async () => {
  try {
    await sessionManager.startDetachedRunObservers();
  } catch (error) {
    console.error('Failed to rehydrate detached runs on startup:', error);
  }
})();

const mailWorker = await embeddedMailWorker.startEmbeddedMailWorker({
  createSession: sessionManager.createSession,
  submitHttpMessage: sessionManager.submitHttpMessage,
  saveAttachments: sessionManager.saveAttachments,
});

async function shutdown() {
  console.log('Shutting down chat server...');
  if (mailWorker) mailWorker.stop();
  await apiRequestLog.closeApiRequestLog();
  await usageLedger.closeUsageLedger();
  triggers.stopTriggerScheduler();
  sessionManager.killAll();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(CHAT_PORT, CHAT_BIND_HOST, () => {
  console.log(`Chat server listening on http://${CHAT_BIND_HOST}:${CHAT_PORT}`);
  console.log(`Cookie mode: ${SECURE_COOKIES ? 'Secure (HTTPS)' : 'Non-secure (localhost)'}`);
});
