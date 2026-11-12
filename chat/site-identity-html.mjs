import { Transform } from 'node:stream';

const assets = { 'script-src': '/site-identity.js', 'style-src': '/site-identity.css', 'connect-src': '/api/site-login/me' };
// Grant only the shared identity resources, retaining each application's policy.
export function siteIdentityCsp(policy, origin) {
  if (!policy || !origin) return policy;
  const directives = new Map(policy.split(';').map(v => v.trim().split(/\s+/)).filter(v => v[0]).map(([key, ...values]) => [key, values]));
  for (const [key, path] of Object.entries(assets)) {
    const selected = key !== 'connect-src' && directives.has(key + '-elem') ? key + '-elem' : key;
    const values = directives.get(selected) || directives.get(key) || directives.get('default-src');
    if (!values || values.includes("'self'") || values.includes('*')) continue;
    const source = origin + path;
    directives.set(selected, [...new Set([...values.filter(v => v !== "'none'"), source])]);
  }
  return [...directives].map(([key, values]) => [key, ...values].join(' ')).join('; ');
}

export function injectSiteIdentityHtml(body, policy = '', origin = '') {
  let text = body.toString('utf8');
  if (/\bsrc=["']\/site-identity\.js["']/i.test(text)) return body;
  if (origin) text = text.replace(/<meta\b[^>]*>/gi, meta => {
    if (!/http-equiv\s*=\s*["']content-security-policy["']/i.test(meta)) return meta;
    return meta.replace(/content\s*=\s*(["'])([\s\S]*?)\1/i, (_, quote, value) => {
      const decoded = value.replace(/&apos;|&#39;/g, "'").replace(/&quot;|&#34;/g, '"').replace(/&amp;/g, '&');
      return `content="${siteIdentityCsp(decoded, origin).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`;
    });
  });
  const nonce = /'nonce-([A-Za-z0-9+/_=-]+)'/.exec(policy)?.[1];
  const tag = `<link rel="stylesheet" href="/site-identity.css"><script defer src="/site-identity.js"${nonce ? ` nonce="${nonce}"` : ''}></script>`;
  const mark = /<\/head\s*>/i.exec(text) || /<body\b[^>]*>/i.exec(text) || /<\/body\s*>/i.exec(text);
  if (!mark) return Buffer.from(tag + text);
  const offset = /^<body/i.test(mark[0]) ? mark.index + mark[0].length : mark.index;
  return Buffer.from(text.slice(0, offset) + tag + text.slice(offset));
}

export function siteIdentityHtmlTransform(policy = '', origin = '') {
  let pending = Buffer.alloc(0), finished = false;
  return new Transform({
    transform(chunk, encoding, callback) {
      if (finished) { this.push(chunk); callback(); return; }
      pending = Buffer.concat([pending, chunk]);
      if (/<\/head\s*>|<body\b[^>]*>/i.test(pending.toString('utf8')) || pending.length >= 256 * 1024) {
        this.push(injectSiteIdentityHtml(pending, policy, origin)); pending = Buffer.alloc(0); finished = true;
      }
      callback();
    },
    flush(callback) { if (pending.length) this.push(injectSiteIdentityHtml(pending, policy, origin)); callback(); },
  });
}
