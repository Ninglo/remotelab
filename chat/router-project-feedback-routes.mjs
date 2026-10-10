import { readBody } from '../lib/utils.mjs';
import { getCachedAuthDocument, loadAuthDocument, findPerson } from '../lib/auth-config.mjs';
import { createProjectFeedbackStore } from './project-feedback.mjs';

function sameOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket?.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return req.headers['sec-fetch-site'] !== 'cross-site'
    && (req.headers.origin ? req.headers.origin === `${proto}://${host}` : Boolean(req.headers.authorization));
}
export function createProjectFeedbackHandler({ store = createProjectFeedbackStore(),
  personLookup = async id => findPerson(getCachedAuthDocument() || await loadAuthDocument(), id) } = {}) {
  return async function handle({ req, res, pathname, authSession, writeJson }) {
    if (pathname !== '/api/project-feedback') return false;
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Vary', 'Cookie, Authorization');
    const send = (status, body) => writeJson(res, status, body);
    if (!authSession?.personId) { send(403, { error: '需要登录后查看或提交反馈。' }); return true; }
    if (!['GET', 'POST'].includes(req.method)) { send(405, { error: 'Method not allowed' }); return true; }
    try {
      if (req.method === 'GET') {
        const params = new URL(req.url, 'http://localhost').searchParams;
        send(200, await store.read(params.has('subproject') ? params.get('subproject') : undefined));
      } else {
        if (!sameOrigin(req)) { send(403, { error: '请从本站提交反馈。' }); return true; }
        if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) { send(415, { error: '需要 JSON 请求。' }); return true; }
        const input = JSON.parse(await readBody(req, 16 * 1024));
        const person = await personLookup(authSession.personId);
        if (!person) { send(403, { error: '登录身份需要重新核对。' }); return true; }
        const saved = await store.submit({ person_id: person.id, name: person.name || person.handle,
          identity_id: authSession.identityId }, input);
        send(saved.duplicate ? 200 : 201, saved);
      }
    } catch (error) {
      const status = ({ INVALID_INPUT: 400, NOT_FOUND: 404, NOT_CONFIGURED: 503, FEEDBACK_CONFLICT: 409, BODY_TOO_LARGE: 413 })[error.code];
      if (status) send(status, { error: error.message });
      else if (error instanceof SyntaxError) send(400, { error: 'JSON 格式无效。' });
      else { console.error('[project-feedback]', error); send(503, { error: '反馈暂时无法读取或保存，请保留内容后重试。' }); }
    }
    return true;
  };
}
export const handleProjectFeedbackRoutes = createProjectFeedbackHandler();
