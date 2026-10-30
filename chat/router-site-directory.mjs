import { readFile } from 'node:fs/promises';
import { createSiteDirectory } from '../lib/site-directory.mjs';
import { getCachedAuthDocument, loadAuthDocument } from '../lib/auth-config.mjs';
import { readBody } from '../lib/utils.mjs';
import { requireEmployeeSite, sameSiteOrigin } from './employee-site-auth.mjs';

export const siteDirectory = createSiteDirectory({ people: async () => (getCachedAuthDocument() || await loadAuthDocument()).people });
export function createSiteDirectoryHandler({ directory = siteDirectory, authorize = requireEmployeeSite } = {}) {
  return async (req, res, pathname) => {
    if (pathname !== '/sites' && !pathname.startsWith('/sites/') && pathname !== '/api/sites' && !pathname.startsWith('/api/sites/')) return false;
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Vary', 'Cookie'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const person = await authorize(req, res); if (!person) return true;
      if (['POST', 'PATCH'].includes(req.method)) {
        if (!sameSiteOrigin(req)) { send(403, { error: '请从项目总站提交登记' }); return true; }
        if (pathname !== '/api/sites/entries') { send(404, { error: '入口不存在' }); return true; }
        const data = JSON.parse(await readBody(req, 16000));
        if (req.method === 'POST' && data.id || req.method === 'PATCH' && typeof data.id !== 'string') { send(400, { error: '登记操作无效' }); return true; }
        send(200, await directory.save(data, person)); return true;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { send(405, { error: 'Method not allowed' }); return true; }
      if (pathname === '/api/sites' || pathname === '/api/sites/export') {
        if (pathname.endsWith('/export')) res.setHeader('Content-Disposition', 'attachment; filename="project-sites.json"');
        send(200, { ...await directory.listing(), viewer: { name: person.name } }); return true;
      }
      const assets = { '/sites': ['../templates/site-directory.html', 'text/html'], '/sites/': ['../templates/site-directory.html', 'text/html'],
        '/sites/app.js': ['../static/site-directory.js', 'text/javascript'], '/sites/style.css': ['../static/site-directory.css', 'text/css'] };
      const asset = assets[pathname]; if (!asset) { send(404, { error: '入口不存在' }); return true; }
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin');
      const body = await readFile(new URL(asset[0], import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) { send(e.status || (e instanceof SyntaxError ? 400 : 503), { error: e.status ? e.message : '暂时无法读取或保存，请保留内容后重试' }); }
    return true;
  };
}
export const handleSiteDirectory = createSiteDirectoryHandler();
