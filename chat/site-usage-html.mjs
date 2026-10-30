import { Transform } from 'node:stream';

export function siteUsageOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket?.encrypted ? 'https' : 'http');
  if (!['http', 'https'].includes(proto)) return '';
  try { const url = new URL(`${proto}://${host}`); return url.username || url.password ? '' : url.origin; } catch { return ''; }
}

// Add only this same-origin path. Other APIs and network origins stay subject
// to the application's previous connect policy.
export function siteUsageCsp(policy, origin) {
  if (!policy || !origin || permits(policy, 'connect')) return policy;
  const source = origin + '/api/site-usage/events';
  if (policy.split(/\s+/).includes(source)) return policy;
  const directives = policy.split(';');
  const at = directives.findIndex(v => /^\s*connect-src(?:\s|$)/i.test(v));
  if (at < 0) return policy.replace(/;?\s*$/, '; ') + 'connect-src ' + source;
  directives[at] = directives[at].replace(/\s+'none'/g, '') + ' ' + source;
  return directives.join(';');
}

function permits(policy, kind) {
  if (!policy) return true;
  const directives = Object.fromEntries(policy.split(';').map(v => v.trim().split(/\s+/)).filter(v => v[0]).map(([k, ...v]) => [k, v]));
  const values = directives[kind === 'script' ? 'script-src-elem' : 'connect-src']
    || (kind === 'script' ? directives['script-src'] : null) || directives['default-src'];
  return !values || values.includes("'self'") || values.includes('*')
    || kind === 'connect' && values.some(v => /^https?:\/\/[^/]+\/api\/site-usage\/events$/.test(v))
    || kind === 'script' && values.some(v => /^'nonce-[A-Za-z0-9+/_=-]+'$/.test(v));
}
export function injectSiteUsageHtml(body, policy = '') {
  const text = body.toString('utf8');
  // Meta CSP is application-owned. Keep it untouched rather than loading a
  // script before its policy or relaxing a restrictive connect-src.
  const metas = [...text.matchAll(/<meta\b[^>]*>/gi)].map(m => m[0]);
  const policies = [policy];
  for (const meta of metas) if (/http-equiv\s*=\s*["']content-security-policy["']/i.test(meta)) {
    const content = /content\s*=\s*(["'])([\s\S]*?)\1/i.exec(meta);
    if (!content) return body;
    policies.push(content[2]);
  }
  if (!policies.every(p => permits(p, 'script') && permits(p, 'connect'))
    || /<script\b[^>]*src\s*=\s*["']\/site-usage\.js(?:[?"'])/i.test(text)) return body;
  const nonce = /'nonce-([A-Za-z0-9+/_=-]+)'/.exec(policy)?.[1];
  const tag = `<script defer src="/site-usage.js"${nonce ? ` nonce="${nonce}"` : ''}></script>`;
  const mark = /<\/head\s*>/i.exec(text) || /<\/body\s*>/i.exec(text);
  if (!mark) return body;
  const offset = Buffer.byteLength(text.slice(0, mark.index));
  return Buffer.concat([body.subarray(0, offset), Buffer.from(tag), body.subarray(offset)]);
}

// Only the initial HTML head is buffered; subsequent business streaming is
// passed through. The bound prevents a malformed page from growing memory.
export function siteUsageHtmlTransform(policy = '') {
  let pending = Buffer.alloc(0), finished = false;
  return new Transform({
    transform(chunk, encoding, callback) {
      if (finished) { this.push(chunk); callback(); return; }
      pending = Buffer.concat([pending, chunk]);
      if (/<\/head\s*>/i.test(pending.toString('utf8')) || pending.length >= 256 * 1024) {
        this.push(injectSiteUsageHtml(pending, policy)); pending = Buffer.alloc(0); finished = true;
      }
      callback();
    },
    flush(callback) { if (pending.length) this.push(injectSiteUsageHtml(pending, policy)); callback(); },
  });
}
