import { codexAuthManager } from './codex-auth.mjs';
import { readBody } from '../lib/utils.mjs';

export async function handleCodexAuthRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
}) {
  if (!pathname.startsWith('/api/codex-auth')) return false;
  if (authSession?.role !== 'owner') {
    writeJson(res, 403, { error: 'Owner access required' });
    return true;
  }

  if (pathname === '/api/codex-auth/status' && req.method === 'GET') {
    try {
      writeJson(res, 200, { codexAuth: await codexAuthManager.getStatus() });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to check Codex login' });
    }
    return true;
  }

  if (pathname === '/api/codex-auth/device-login' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 4096);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const codexAuth = await codexAuthManager.startDeviceLogin({
        restart: payload?.restart === true,
      });
      writeJson(res, 200, { codexAuth });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to start Codex login' });
    }
    return true;
  }

  writeJson(res, 404, { error: 'Codex login route not found' });
  return true;
}
