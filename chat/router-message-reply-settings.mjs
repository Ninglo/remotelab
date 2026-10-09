import { readBody } from '../lib/utils.mjs';
import { loadPersonMessageReplies, changePersonMessageReplies } from './person-message-replies.mjs';
import { requests } from './requests.mjs';

// Conversation-driven changes use the accepted human Request, not the CLI's
// owner/service credential or a Person supplied by the caller.
async function currentRunActor(runId, authSession, write) {
  const record = typeof runId === 'string' && /^run_[a-zA-Z0-9_-]+$/.test(runId) ? await requests.byRunId(runId) : null;
  const options = record?.options;
  if (!record || !options?.viewPersonId || !options.initiatedByIdentityId
      || options.internalOperation || options.automationTitle || options.recordUserMessage === false
      || ['app', 'bot'].includes(options.sourceContext?.sender?.senderType)
      || write && (record.result || record.releasedAt)
      || authSession?.authKind !== 'service' && authSession?.personId !== options.viewPersonId) {
    throw Object.assign(new Error('修改需要当前运行中已接受的本人请求。'), { status: 403 });
  }
  return { personId: options.viewPersonId, identityId: options.initiatedByIdentityId,
    authKind: 'accepted-run', runId: record.runId, requestId: record.requestId, sessionId: record.sessionId };
}

export async function handleMessageReplySettings({ req, res, pathname, parsedUrl, authSession, writeJson }) {
  if (!['/api/message-reply-settings', '/api/message-reply-settings/current-run'].includes(pathname)) return false;
  try {
    if (pathname.endsWith('/current-run')) {
      if (!['GET', 'POST'].includes(req.method)) { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const input = req.method === 'POST' ? JSON.parse(await readBody(req, 32768) || '{}') : {};
      if (Object.keys(input).some(key => !['runId', 'enabled', 'expectedRevision', 'confirm'].includes(key))) {
        throw new Error('未知的开工严格检查操作。');
      }
      const actor = await currentRunActor(input.runId || parsedUrl?.searchParams.get('runId'), authSession, req.method === 'POST');
      const settings = req.method === 'GET' ? await loadPersonMessageReplies(actor)
        : await changePersonMessageReplies({ action: 'strict-start', enabled: input.enabled,
          expectedRevision: input.expectedRevision, confirm: input.confirm }, actor);
      writeJson(res, 200, { settings });
      return true;
    }
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
