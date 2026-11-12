import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { CONFIG_DIR } from '../lib/config.mjs';
import { requireEmployeeSite, sameSiteOrigin } from './employee-site-auth.mjs';
import { handleSiteLogin } from './router-site-login.mjs';
import { siteIdentityCsp, siteIdentityHtmlTransform } from './site-identity-html.mjs';

const ASSETS = { '/site-login.js': ['site-login.js', 'text/javascript'], '/site-identity.js': ['site-identity.js', 'text/javascript'], '/site-identity.css': ['site-identity.css', 'text/css'] };
const reply = (res, status, message) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify({ error: message })); };
export async function loadEmployeeHosts(configDir = CONFIG_DIR) {
  let document;
  try { document = JSON.parse(await readFile(join(configDir, 'employee-site-hosts.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (document.version !== 1 || !document.hosts || typeof document.hosts !== 'object' || Array.isArray(document.hosts)) throw Error('Invalid employee site hosts');
  for (const [host, route] of Object.entries(document.hosts)) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(host) || !Number.isInteger(route.port) || route.port < 1 || route.port > 65535
      || !Array.isArray(route.readPaths) || route.readPaths.some(p => typeof p !== 'string' || !p.startsWith('^') || !p.endsWith('$'))
      || ['postPaths', 'publicHealthPaths', 'forwardCookies'].some(k => route[k] !== undefined && (!Array.isArray(route[k]) || route[k].some(p => typeof p !== 'string')))
      || route.forwardCookies?.some(p => !/^[a-zA-Z0-9_-]+$/.test(p) || ['employee_site_session', 'qianyan_session', 'remotelab_session'].includes(p))) throw Error('Invalid employee host route');
    route.readPaths.forEach(p => new RegExp(p));
  }
  return document.hosts;
}

// Exact host dispatch occurs before the workbench router. An employee website
// never exposes console APIs, even to an authenticated employee.
export function createEmployeeHostHandler({ routes = loadEmployeeHosts, requirePerson = requireEmployeeSite, login = handleSiteLogin } = {}) {
  return async (req, res) => {
    let hosts;
    try { hosts = await routes(); } catch { reply(res, 503, '网站认证配置暂不可用'); return true; }
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    const route = hosts[host];
    if (!route) return false;
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const decoded = decodeURIComponent(path);
      if (/[\\\x00-\x1f\x7f%]/.test(decoded) || decoded.split('/').some(p => p === '..' || p === '.')) { reply(res, 400, '无效路径'); return true; }
      // Forwarded host values are supplied by the reverse proxy, never clients.
      req.headers['x-forwarded-host'] = req.headers.host;
      if (path === '/site-login' || /^\/api\/site-login\/(?:me|start|poll|logout|sso\/(?:config|start|authorize|callback))$/.test(path)) {
        await login(req, res, path); return true;
      }
      if (Object.hasOwn(ASSETS, path) && ['GET', 'HEAD'].includes(req.method)) {
        const [file, type] = ASSETS[path];
        const body = await readFile(new URL('../static/' + file, import.meta.url));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : body); return true;
      }
      const read = ['GET', 'HEAD'].includes(req.method);
      if (!(read && route.readPaths.some(p => new RegExp(p).test(path))) && !(req.method === 'POST' && route.postPaths?.includes(path))) {
        reply(res, 404, '未开放此入口'); return true;
      }
      const health = read && route.publicHealthPaths?.includes(path);
      const person = health ? null : await requirePerson(req, res);
      if (!health && !person) return true;
      if (!read && !sameSiteOrigin(req)) { reply(res, 403, '请从当前网站提交'); return true; }
      const headers = { 'accept-encoding': 'identity' };
      for (const name of ['accept', 'range', 'if-range', 'if-none-match', 'if-modified-since', 'content-type', 'content-length', 'origin']) {
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      }
      if (person) headers['x-remotelab-person-id'] = person.id;
      const cookies = String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => route.forwardCookies?.includes(v.split('=')[0]));
      if (cookies.length) headers.cookie = cookies.join('; ');
      const proto = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted ? 'https' : 'http';
      const origin = `${proto}://${req.headers.host}`;
      const upstream = http.request({ hostname: '127.0.0.1', port: route.port, path: path + url.search, method: req.method, headers,
        timeout: route.timeoutMs || 0 }, response => {
        const output = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'content-encoding', 'content-security-policy', 'location', 'etag', 'last-modified', 'x-frame-options']) {
          if (response.headers[name]) output[name] = response.headers[name];
        }
        // Only original application cookies cross this boundary; employee cookies stay here.
        const setCookies = (response.headers['set-cookie'] || []).filter(v => route.forwardCookies?.includes(v.split('=')[0]));
        if (setCookies.length) output['Set-Cookie'] = [...(Array.isArray(res.getHeader('Set-Cookie')) ? res.getHeader('Set-Cookie') : res.getHeader('Set-Cookie') ? [res.getHeader('Set-Cookie')] : []), ...setCookies];
        const html = person && req.method === 'GET' && !req.headers.range && response.statusCode === 200 && /^text\/html(?:;|$)/i.test(response.headers['content-type'] || '');
        let stream = response;
        if (html) {
          const encoding = response.headers['content-encoding'];
          if (encoding && encoding !== 'identity') {
            const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding]?.();
            if (!decoder) { response.resume(); reply(res, 502, '网站响应编码不支持'); return; }
            decoder.on('error', () => res.destroy()); stream = response.pipe(decoder);
          }
          delete output['content-length']; delete output['content-encoding']; delete output.etag;
          output['content-security-policy'] = siteIdentityCsp(output['content-security-policy'] || "frame-ancestors 'self'", origin);
        }
        res.writeHead(response.statusCode || 502, output);
        if (req.method === 'HEAD') { response.resume(); res.end(); }
        else if (html) stream.pipe(siteIdentityHtmlTransform(output['content-security-policy'], origin)).pipe(res);
        else stream.pipe(res);
        response.on('error', () => res.destroy());
      });
      upstream.on('timeout', () => upstream.destroy(Error('Upstream timed out')));
      upstream.on('error', () => { if (!res.headersSent) reply(res, 502, '网站服务暂不可用'); else res.destroy(); });
      req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy());
      req.pipe(upstream);
      return true;
    } catch { if (!res.headersSent) reply(res, 503, '网站暂不可用'); else res.destroy(); return true; }
  };
}
export const handleEmployeeHost = createEmployeeHostHandler();
