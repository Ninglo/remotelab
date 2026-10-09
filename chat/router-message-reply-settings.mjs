import { readBody } from '../lib/utils.mjs';
import { loadPersonMessageReplies, changePersonMessageReplies } from './person-message-replies.mjs';

export async function handleMessageReplySettings({ req, res, pathname, authSession, writeJson }) {
  if (pathname !== '/api/message-reply-settings') return false;
  try {
    if (!authSession?.personId || !authSession?.identityId || authSession.authKind === 'service') {
      throw Object.assign(new Error('请使用本人的登录账号查看或修改回复设置。'), { status: 403 });
    }
    if (req.method === 'GET') writeJson(res, 200, { settings: await loadPersonMessageReplies(authSession) });
    else if (req.method === 'POST') {
      const input = JSON.parse(await readBody(req, 32768) || '{}');
      writeJson(res, 200, { settings: await changePersonMessageReplies(input, authSession) });
    } else writeJson(res, 405, { error: 'Method not allowed' });
  } catch (error) { writeJson(res, error.status || 400, { error: error.message }); }
  return true;
}
