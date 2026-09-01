import { piAuthManager } from './pi-auth.mjs';

export async function handlePiAuthRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
  authManager = piAuthManager,
}) {
  if (!pathname.startsWith('/api/pi-auth')) return false;
  if (authSession?.role !== 'owner') {
    writeJson(res, 403, { error: 'Owner access required' });
    return true;
  }

  if (pathname === '/api/pi-auth/status' && req.method === 'GET') {
    try {
      writeJson(res, 200, { piAuth: await authManager.getStatus() });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to check Pi login' });
    }
    return true;
  }

  if (pathname === '/api/pi-auth/logout' && req.method === 'POST') {
    try {
      writeJson(res, 200, { piAuth: await authManager.logout() });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to log out of Pi' });
    }
    return true;
  }

  if (pathname === '/api/pi-auth/sync-codex' && req.method === 'POST') {
    try {
      writeJson(res, 200, { piAuth: await authManager.syncCodexLogin() });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to sync the Codex login to Pi' });
    }
    return true;
  }

  writeJson(res, 404, { error: 'Pi login route not found' });
  return true;
}
