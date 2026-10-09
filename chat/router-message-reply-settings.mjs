import { readBody } from '../lib/utils.mjs';
import { loadMessageReplySettings, listMessageReplyGroups, changeMessageReplySettings } from './message-reply-settings.mjs';
import { usesOctober7GroupMessaging } from '../lib/session-progress-policy.mjs';

export async function handleMessageReplySettings({ req, res, pathname, authSession, writeJson }) {
  if (pathname !== '/api/message-reply-settings') return false;
  try {
    if (req.method === 'GET') writeJson(res, 200, {
      settings: await loadMessageReplySettings(), groups: await listMessageReplyGroups(),
      defaultMechanism: usesOctober7GroupMessaging({ conversation: { connector: 'feishu', target: { chatType: 'group' } } })
        ? 'selectable_progress_card' : 'folded_task_card' });
    else if (req.method === 'POST') {
      if (!authSession?.personId || !authSession?.identityId) throw Object.assign(new Error('请先登录。'), { status: 403 });
      const input = JSON.parse(await readBody(req, 32768) || '{}');
      writeJson(res, 200, { settings: await changeMessageReplySettings(input, authSession) });
    } else writeJson(res, 405, { error: 'Method not allowed' });
  } catch (error) { writeJson(res, error.status || 400, { error: error.message }); }
  return true;
}
