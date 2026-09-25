import { readBody } from '../lib/utils.mjs';
import { claudeAuthManager } from './claude-auth.mjs';

export async function handleClaudeAuthRoutes({ req, res, pathname, writeJson, authManager = claudeAuthManager }) {
  if (!pathname.startsWith('/api/claude-auth')) return false;
  res.setHeader?.('Cache-Control', 'private, no-store');

  if (pathname === '/api/claude-auth/status' && req.method === 'GET') {
    try { writeJson(res, 200, { claudeAuth: await authManager.getStatus() }); }
    catch (error) { writeJson(res, 500, { error: error.message || 'Failed to check Claude login' }); }
    return true;
  }

  if (pathname === '/api/claude-auth/login' && req.method === 'POST') {
    try {
      const raw = await readBody(req, 4096);
      const payload = raw ? JSON.parse(raw) : {};
      writeJson(res, 200, { claudeAuth: await authManager.startLogin({ restart: payload?.restart === true }) });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to start Claude login' });
    }
    return true;
  }

  if (pathname === '/api/claude-auth/code' && req.method === 'POST') {
    try {
      const raw = await readBody(req, 4096);
      const payload = JSON.parse(raw);
      writeJson(res, 200, { claudeAuth: await authManager.submitCode(payload?.code) });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to submit Claude login code' });
    }
    return true;
  }

  if (pathname === '/api/claude-auth/logout' && req.method === 'POST') {
    try { writeJson(res, 200, { claudeAuth: await authManager.logout() }); }
    catch (error) { writeJson(res, 500, { error: error.message || 'Failed to log out of Claude' }); }
    return true;
  }

  writeJson(res, 404, { error: 'Claude login route not found' });
  return true;
}
