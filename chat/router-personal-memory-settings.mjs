import { listPersonalMemories, reviewPersonalMemory } from './personal-memory-review.mjs';
import { readBody } from '../lib/utils.mjs';
import { currentRunActor } from './router-message-reply-settings.mjs';
import { loadPersonalMemorySettings, changePersonalMemorySettings } from './personal-memory-settings.mjs';

export async function handlePersonalMemorySettings({ req, res, pathname, parsedUrl, authSession, writeJson }) {
  if (!['/api/personal-memory-settings', '/api/personal-memory-settings/current-run', '/api/personal-memory-entries'].includes(pathname)) return false;
  try {
    res.setHeader?.('Cache-Control', 'no-store');
    if (pathname === '/api/personal-memory-entries') {
      if (Object.keys(parsedUrl?.query || {}).some(k => k !== 'after')) throw Object.assign(new Error('只可审阅本人记忆。'), { status: 403 });
      if (req.method === 'GET') writeJson(res, 200, await listPersonalMemories(authSession, { after: parsedUrl?.query?.after || '' }));
      else if (req.method === 'POST') writeJson(res, 200, await reviewPersonalMemory(JSON.parse(await readBody(req, 8192) || '{}'), authSession));
      else writeJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    if (!['GET', 'POST'].includes(req.method)) { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    const input = req.method === 'POST' ? JSON.parse(await readBody(req, 8192) || '{}') : {};
    const viaRun = pathname.endsWith('/current-run');
    if (Object.keys(input).some(k => !['enabled', 'expectedRevision', 'confirm', ...(viaRun ? ['runId'] : [])].includes(k))) {
      throw new Error('未知的个人记忆设置操作。');
    }
    const actor = viaRun ? await currentRunActor(input.runId || parsedUrl?.query?.runId, authSession, req.method === 'POST') : authSession;
    const { runId, ...change } = input;
    const settings = req.method === 'GET' ? await loadPersonalMemorySettings(actor) : await changePersonalMemorySettings(change, actor);
    writeJson(res, 200, { settings });
  } catch (error) { writeJson(res, error.status || 400, { error: error.message }); }
  return true;
}
