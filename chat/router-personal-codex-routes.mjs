import { readBody } from '../lib/utils.mjs';
import { personalCodexAuthManager } from './personal-codex-auth.mjs';

export async function handlePersonalCodexRoutes({ req, res, pathname, authSession, writeJson,
  authManager = personalCodexAuthManager }) {
  if (!pathname.startsWith('/api/personal-codex/')) return false;
  res.setHeader?.('Cache-Control', 'private, no-store');
  // A service credential is not consent to bind a human's ChatGPT account.
  const personId = authSession?.personId;
  if (!personId || authSession.authKind === 'service' || personId === 'person_system') {
    writeJson(res, 403, { error: '请使用本人的 RemoteLab 账号登录后绑定' }); return true;
  }
  try {
    let state;
    if (pathname === '/api/personal-codex/status' && req.method === 'GET') {
      state = await authManager.getStatus(personId, { refresh: new URL(req.url || pathname, 'http://localhost').searchParams.get('refresh') === '1' });
    } else if (req.method === 'POST') {
      const payload = JSON.parse(await readBody(req, 4096) || '{}');
      if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'restart')) {
        writeJson(res, 400, { error: '个人绑定不接受其他用户、账号或凭据参数' }); return true;
      }
      if (pathname === '/api/personal-codex/device-login') state = await authManager.startDeviceLogin(personId, { restart: payload.restart === true });
      else if (pathname === '/api/personal-codex/cancel-login') state = await authManager.cancelLogin(personId);
      else if (pathname === '/api/personal-codex/logout') state = await authManager.logout(personId);
    }
    if (!state) writeJson(res, 404, { error: '个人 Codex 接口不存在' });
    else writeJson(res, 200, { codexAuth: state });
  } catch (error) { writeJson(res, 400, { error: error.message || '个人 Codex 操作失败' }); }
  return true;
}
