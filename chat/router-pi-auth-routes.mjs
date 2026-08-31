import { readBody } from '../lib/utils.mjs';
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

  if (pathname === '/api/pi-auth/device-login' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 4096);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const piAuth = await authManager.startDeviceLogin({
        restart: payload?.restart === true,
      });
      writeJson(res, 200, { piAuth });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to start Pi login' });
    }
    return true;
  }

  writeJson(res, 404, { error: 'Pi login route not found' });
  return true;
}
