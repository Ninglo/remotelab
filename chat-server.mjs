#!/usr/bin/env node
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { readActiveReleaseManifest, shouldUseActiveRelease } from './lib/release-runtime.mjs';

const sourceProjectRoot = fileURLToPath(new URL('.', import.meta.url));
let delegatedToRelease = false;

if (shouldUseActiveRelease()) {
  try {
    const activeRelease = await readActiveReleaseManifest();
    if (activeRelease?.snapshotRoot) {
      delegatedToRelease = true;
      process.env.REMOTELAB_PROJECT_ROOT = process.env.REMOTELAB_PROJECT_ROOT || sourceProjectRoot;
      process.env.REMOTELAB_SOURCE_PROJECT_ROOT = process.env.REMOTELAB_SOURCE_PROJECT_ROOT || sourceProjectRoot;
      delete process.env.REMOTELAB_ACTIVE_RELEASE_ROOT;
      delete process.env.REMOTELAB_ACTIVE_RELEASE_FILE;
      delete process.env.REMOTELAB_ACTIVE_RELEASE_ID;
      process.env.REMOTELAB_DISABLE_ACTIVE_RELEASE = '1';
      await import(pathToFileURL(join(activeRelease.snapshotRoot, 'chat-server.mjs')).href);
    }
  } catch (error) {
    console.error(`[release] Failed to boot the active release: ${error.message}`);
    console.error('[release] Falling back to the source runtime');
    delegatedToRelease = false;
  }
}

if (!delegatedToRelease) {
  const http = await import('http');
  const [{ CHAT_PORT, CHAT_BIND_HOST, SECURE_COOKIES, MEMORY_DIR }, { handleRequest }, apiRequestLog, ws, sessionManager, { ensureDir }] = await Promise.all([
    import('./lib/config.mjs'),
    import('./chat/router.mjs'),
    import('./chat/api-request-log.mjs'),
    import('./chat/ws.mjs'),
    import('./chat/session-manager.mjs'),
    import('./chat/fs-utils.mjs'),
  ]);

  for (const dir of [MEMORY_DIR, join(MEMORY_DIR, 'tasks')]) {
    await ensureDir(dir);
  }

  await apiRequestLog.initApiRequestLog();

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
  try {
    await sessionManager.startDetachedRunObservers();
  } catch (error) {
    console.error('Failed to rehydrate detached runs on startup:', error);
  }

  async function shutdown() {
    console.log('Shutting down chat server...');
    await apiRequestLog.closeApiRequestLog();
    sessionManager.killAll();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(CHAT_PORT, CHAT_BIND_HOST, () => {
    console.log(`Chat server listening on http://${CHAT_BIND_HOST}:${CHAT_PORT}`);
    console.log(`Cookie mode: ${SECURE_COOKIES ? 'Secure (HTTPS)' : 'Non-secure (localhost)'}`);
  });
}
