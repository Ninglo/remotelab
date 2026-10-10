import { readFile, writeFile, mkdir, rename, lstat, realpath, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readBody } from '../lib/utils.mjs';

const PREFIX = '/api/qianyan/internal/source-credentials';
const KEY_FILE = 'source-providers.json';
const bad = (status, message) => Object.assign(new Error(message), { status });

// This endpoint handles a credential, never a chat message or research record.
// Only the instance-configured credential contributor can use the form. Service
// tokens and other employees cannot submit a key or mint a form token.
export function createQianyanSourceCredentials({ configDir, project, now = Date.now }) {
  const tokens = new Map();
  let queue = Promise.resolve();
  async function allowed(person) {
    if (!person || !['remotelab', 'feishu'].includes(person.auth_kind)) return false;
    const cfg = JSON.parse(await readFile(join(configDir, 'qianyan-internal.json'), 'utf8'));
    return cfg.sourceCredentialPersonIds?.includes(person.id) === true;
  }
  async function directory() {
    const root = await realpath(project);
    for (const path of [join(root, 'private'), join(root, 'private/secrets')]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw bad(503, '凭据保存位置需要检查');
    }
    const dir = join(root, 'private/secrets');
    await chmod(dir, 0o700);
    return dir;
  }
  async function stored() {
    const path = join(await directory(), KEY_FILE);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw bad(503, '凭据文件权限需要检查');
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(503, '凭据文件需要检查');
      return { path, value };
    } catch (e) {
      if (e.code === 'ENOENT') return { path, value: {} };
      throw e;
    }
  }
  async function save(key) {
    const operation = queue.then(async () => {
      const { path, value } = await stored();
      const tmp = path + '.' + randomBytes(12).toString('hex');
      try {
        await writeFile(tmp, JSON.stringify({ ...value, DAJIALA_KEY: key }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(tmp, path);
      } finally { await unlink(tmp).catch(() => {}); }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  function token(person) {
    for (const [key, entry] of tokens) if (entry.until <= now()) tokens.delete(key);
    if (tokens.size >= 100) throw bad(429, '打开的输入页较多，请稍后重试');
    const value = randomBytes(32).toString('hex');
    tokens.set(value, { person: person.id, until: now() + 10 * 60000 });
    return value;
  }
  function consume(value, person) {
    const entry = tokens.get(value);
    if (!entry || entry.person !== person.id || entry.until <= now()) throw bad(403, '输入页已过期，请刷新后重新填写');
    tokens.delete(value);
  }
  return async function handle({ req, res, pathname, person, writeJson }) {
    if (pathname !== PREFIX && pathname !== PREFIX + '/status') return false;
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    try {
      if (!await allowed(person)) {
        if (!person && req.method === 'GET' && pathname === PREFIX) {
          res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>公众号密钥输入</title><main style="max-width:440px;margin:12vh auto;padding:24px;font:16px/1.7 system-ui"><h1>先确认你的身份</h1><p>请用本人的 RemoteLab 账号登录，登录后会回到输入页。</p><a href="/login?next=%2Fapi%2Fqianyan%2Finternal%2Fsource-credentials">登录并继续</a></main>');
        } else writeJson(res, person ? 403 : 401, { error: '请使用获授权的本人账号打开输入页' });
        return true;
      }
      if (req.method === 'GET' && pathname === PREFIX + '/status') {
        const { value } = await stored();
        writeJson(res, 200, { configured: !!value.DAJIALA_KEY });
        return true;
      }
      if (req.method === 'GET' && pathname === PREFIX) {
        const nonce = randomBytes(18).toString('hex');
        const page = await readFile(new URL('../templates/qianyan-source-credentials.html', import.meta.url), 'utf8');
        const formToken = token(person);
        res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page.replaceAll('{{NONCE}}', nonce).replaceAll('{{FORM_TOKEN}}', formToken));
        return true;
      }
      if (req.method !== 'POST' || pathname !== PREFIX) { writeJson(res, 405, { error: '不支持的操作' }); return true; }
      if (!String(req.headers['content-type']).startsWith('application/json')) throw bad(415, '提交格式无效');
      consume(req.headers['x-form-token'], person);
      const body = JSON.parse(await readBody(req, 8192));
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!/^[\x21-\x7e]{8,4096}$/.test(key)) throw bad(400, '请粘贴完整的 API Key，不要填写账号密码');
      await save(key);
      writeJson(res, 200, { saved: true, configured: true });
    } catch (e) {
      // Do not return exceptions containing credentials, request bodies or paths.
      writeJson(res, e.status || (e.code === 'BODY_TOO_LARGE' ? 413 : e instanceof SyntaxError ? 400 : 503),
        { error: e.status ? e.message : '暂时无法保存，请刷新输入页后重试' });
    }
    return true;
  };
}
