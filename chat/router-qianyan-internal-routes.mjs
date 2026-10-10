import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from '../lib/config.mjs';
import { getAuthSession, authenticateBearerToken } from '../lib/auth.mjs';
import { getCachedAuthDocument, loadAuthDocument, updateAuthDocument } from '../lib/auth-config.mjs';
import { readBody } from '../lib/utils.mjs';
import { createQianyanIdentity } from '../knowledge/qianyan-identity.mjs';
import { createQianyanCollaboration } from '../knowledge/qianyan-collaboration.mjs';
import { createQianyanSourceCredentials } from '../knowledge/qianyan-source-credentials.mjs';

async function registerIdentity({ realm, openId, name }) {
  // Match verified IDs within an app realm. Names never authorize an account merge.
  const result = await updateAuthDocument(document => {
    let p = document.people.find(p => p.identities.some(i => i.kind === 'feishu' && i.realm === realm && i.subjectId === openId));
    if (!p) {
      p = { id: 'person_' + randomUUID().replaceAll('-', '').slice(0, 24), name: name || '飞书员工', discovered: true,
        credentials: [], identities: [{ id: 'identity_' + randomUUID(), kind: 'feishu', realm, subjectId: openId, displayName: name }], preferences: {} };
      document.people.push(p);
    }
    return { id: p.id, name: p.name };
  });
  return result.result;
}
const project = process.env.REMOTELAB_QIANYAN_PROJECT || join(homedir(), '.remotelab/workspace/qianyan-workbench');
const identity = createQianyanIdentity({ configDir: CONFIG_DIR,
  authDocument: async () => getCachedAuthDocument() || await loadAuthDocument(), registerIdentity });
const collaboration = createQianyanCollaboration({ configDir: CONFIG_DIR,
  documentsPath: join(project, 'private/pipeline/research_documents.json'), publicDataPath: join(project, 'build/data.json'),
  sourceCatalogPath: join(project, 'private/pipeline/source_catalog.json'),
  pipelineMetricsPath: join(project, 'private/observability/last_run.json'),
  corpusPath: process.env.REMOTELAB_QIANYAN_CORPUS || join(project, 'private/pipeline/agent_corpus.json') });
const sourceCredentials = createQianyanSourceCredentials({ configDir: CONFIG_DIR, project });

function sameOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket?.encrypted ? 'https' : 'http');
  return !req.headers.origin && !!req.headers.authorization || req.headers.origin === `${proto}://${host}`;
}
export function createQianyanInternalHandler({ identityService = identity, collaborationService = collaboration, sourceCredentialService = sourceCredentials,
  remoteSession = async req => { await authenticateBearerToken(req); return getAuthSession(req); } } = {}) {
  return async function handle({ req, res, pathname, writeJson }) {
    const prefix = '/api/qianyan/internal/'; if (!pathname.startsWith(prefix)) return false;
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Vary', 'Cookie, Authorization');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const action = pathname.slice(prefix.length), params = new URL(req.url, 'http://localhost').searchParams;
    const send = (code, value) => writeJson(res, code, value);
    try {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) { send(405, { error: 'Method not allowed' }); return true; }
      if (req.method !== 'GET' && !sameOrigin(req)) { send(403, { error: '请从本站提交' }); return true; }
      const person = await identityService.member(req, await remoteSession(req));
      if (await sourceCredentialService({ req, res, pathname, person, writeJson })) return true;
      if (action === 'auth/me' && req.method === 'GET') {
        if (person) {
          const renewed = await identityService.renew?.(req, person);
          if (renewed) res.setHeader('Set-Cookie', renewed);
        }
        send(person ? 200 : 401, person ? { person, visibility: 'company' } : { error: '请使用员工身份登录', feishu_login: true }); return true;
      }
      if (action === 'auth/start' && req.method === 'POST') {
        if (person) { send(200, { state: 'connected', person }); return true; }
        const value = await identityService.begin(req); if (value.cookie) res.setHeader('Set-Cookie', value.cookie);
        const { cookie, ...publicValue } = value; send(200, publicValue); return true;
      }
      if (action === 'auth/poll' && req.method === 'GET') {
        const value = await identityService.poll(req); if (value.cookies) res.setHeader('Set-Cookie', value.cookies);
        const { cookies, ...publicValue } = value; send(200, publicValue); return true;
      }
      if (!person) { send(401, { error: '请使用公司员工身份登录' }); return true; }
      let body;
      if (req.method === 'POST') body = JSON.parse(await readBody(req, 32 * 1024));
      const api = collaborationService;
      if (action === 'mcp' && req.method === 'POST') {
        const result = await api.researchQuery('mcp', body);
        if (result === null) { res.writeHead(202); res.end(); } else send(200, result);
      }
      else if (action === 'documents' && req.method === 'GET') send(200, await api.listDocuments());
      else if (action === 'document' && req.method === 'GET') send(200, await api.readDocument(params.get('id'), params.get('revision')));
      else if (action === 'comments' && req.method === 'GET') send(200, await api.comments(Object.fromEntries(params), person));
      else if (action === 'comments' && req.method === 'POST') send(201, await api.addComment(person, body));
      else if (action === 'votes' && req.method === 'POST') send(200, await api.vote(person, body));
      else if (action === 'reactions' && req.method === 'GET') send(200, await api.reactions(person));
      else if (action === 'feedback/review' && req.method === 'POST') send(200, await api.reviewFeedback(person, body));
      else if (action === 'activity' && req.method === 'POST') send(201, await api.activity(person, body));
      else if (action === 'observability' && req.method === 'GET') send(200, await api.observability());
      else if (action === 'submissions' && req.method === 'GET') send(200, await api.submissions());
      else if (action === 'submissions' && req.method === 'POST') send(201, await api.submit(person, body));
      else if (action === 'submissions/review' && req.method === 'POST') send(200, await api.review(person, body));
      else if (action === 'source-catalog' && req.method === 'GET') send(200, await api.sourceCatalog());
      else if (action === 'source-proposals' && req.method === 'GET') send(200, await api.sourceProposals());
      else if (action === 'source-proposals' && req.method === 'POST') send(201, await api.proposeSource(person, body));
      else if (action === 'source-proposals/review' && req.method === 'POST') send(200, await api.reviewSource(person, body));
      else if (action === 'export' && req.method === 'GET') send(200, await api.exportFeedback(person));
      else if (['comments', 'submissions'].includes(action) && req.method === 'DELETE') send(200, await api.remove(person, action === 'comments' ? 'comment' : 'submission', params.get('id')));
      else if (['search', 'read', 'context', 'updates'].includes(action) && req.method === 'GET') send(200, await api.researchQuery(action, Object.fromEntries(params)));
      else send(404, { error: '入口不存在' });
    } catch (e) {
      const code = e.status || (e instanceof SyntaxError ? 400 : e.code === 'BODY_TOO_LARGE' ? 413 : 503);
      send(code, { error: e.status ? e.message : code === 400 ? '提交格式无效' : '暂时无法处理，请保留内容后重试' });
    }
    return true;
  };
}
export const handleQianyanInternalRoutes = createQianyanInternalHandler();
