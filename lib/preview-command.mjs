import { resolveSitePolicy, siteLoginConfigured } from './site-publication-policy.mjs';
import http from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PREVIEW_ROUTES_FILE, validPreviewPort, validPreviewSlug, validPreviewPostPath, validPreviewRequestHeader } from '../chat/preview-proxy.mjs';
import { PUBLIC_BASE_URL } from './config.mjs';
import { recordSiteOrigin } from './site-directory.mjs';
import { setPreviewIdentityPolicy, legacySiteLogin } from './legacy-site-login.mjs';

async function readRoutes() {
  try {
    const value = JSON.parse(await readFile(PREVIEW_ROUTES_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function saveRoutes(routes) {
  await mkdir(dirname(PREVIEW_ROUTES_FILE), { recursive: true });
  const temporary = `${PREVIEW_ROUTES_FILE}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(routes, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, PREVIEW_ROUTES_FILE);
}

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json' || arg === '--replace') options[arg.slice(2)] = true;
    else if (arg === '--slug' || arg === '--port' || arg === '--access' || arg === '--owner' || arg === '--credential-file') options[arg.slice(2)] = args[++i];
    else if (arg === '--post-path' || arg === '--forward-header') {
      const key = arg === '--post-path' ? 'postPaths' : 'requestHeaders';
      (options[key] ||= []).push(args[++i]);
    }
    else throw new Error(`Unknown preview option: ${arg}`);
  }
  return options;
}

function probeAuth(port, employee = false) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: employee ? 'GET' : 'HEAD', timeout: 5000 }, (res) => {
      const challenges = res.headers['www-authenticate'];
      if (employee) {
        let body = '', bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes <= 65536) body += chunk; });
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 400
          && !challenges && !/\/(?:login|signin|sign-in|auth)(?:[/?#]|$)/i.test(res.headers.location || '')
          && !/<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(body)));
        return;
      }
      res.resume();
      resolve(res.statusCode === 401 && typeof challenges === 'string' && /(?:^|,)\s*Basic(?:\s|$)/i.test(challenges));
    });
    req.on('timeout', () => req.destroy(new Error('Preview service timed out')));
    req.on('error', reject);
    req.end();
  });
}

export async function runPreviewCommand(args = []) {
  const [action, ...rest] = args;
  if (action === '--help' || !action) {
    console.log('Usage: remotelab preview expose --slug <name> --port <loopback-port> [--access employee|basic] [--owner person-id] [--post-path /exact/path] [--forward-header x-app-header] [--replace] [--json] | migrate-login --slug <name> --credential-file <private-json> [--json] | reuse-identity --slug <name> [--json] | recognize-identity --slug <name> [--json] | list [--json] | unexpose --slug <name> [--json]');
    return 0;
  }
  const options = parseOptions(rest);
  if (action === 'list') {
    console.log(JSON.stringify(await readRoutes(), null, 2));
    return 0;
  }
  if (!validPreviewSlug(options.slug)) throw new Error('Invalid preview slug');
  const routes = await readRoutes();
  if (action === 'migrate-login') {
    const route = routes[options.slug];
    if (!route) throw new Error('Preview route not found');
    if (!await siteLoginConfigured()) throw new Error('Configure employee login before migrating a website');
    if (!options['credential-file']) throw new Error('Supply --credential-file with authorization and employees/personIds scope');
    const binding = JSON.parse(await readFile(options['credential-file'], 'utf8'));
    const check = await fetch(`http://127.0.0.1:${route.port}/`, {
      headers: { Authorization: binding.authorization }, redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    await check.body?.cancel();
    if (check.status < 200 || check.status >= 500 || [401, 403].includes(check.status)) throw new Error('Original upstream credential did not pass; login policy left unchanged');
    await legacySiteLogin.bindSite(options.slug, route.port, binding);
    await setPreviewIdentityPolicy(options.slug, route.port, 'employeeLogin');
    console.log(JSON.stringify({ slug: options.slug, employeeLogin: true, originalCallsPreserved: true,
      scope: binding.employees ? 'employees' : 'original-people', personCount: binding.personIds?.length || 0 }));
    return 0;
  }
  if (action === 'recognize-identity') {
    const route = routes[options.slug];
    if (!route) throw new Error('Preview route not found');
    if (!await probeAuth(route.port, true)) throw new Error('The existing public upstream is not healthy; route left unchanged');
    await setPreviewIdentityPolicy(options.slug, route.port, 'recognizeIdentity');
    console.log(JSON.stringify({ slug: options.slug, recognizeIdentity: true, preservedOriginalAccess: true }));
    return 0;
  }
  if (action === 'reuse-identity') {
    const route = routes[options.slug];
    if (!route) throw new Error('Preview route not found');
    if ((route.access || 'basic') !== 'basic') throw new Error('Identity reuse applies to existing Basic routes');
    if (!await probeAuth(route.port)) throw new Error('The original root must still require Basic authentication; route left unchanged');
    await setPreviewIdentityPolicy(options.slug, route.port, 'reuseIdentity');
    console.log(JSON.stringify({ slug: options.slug, access: 'basic', reuseIdentity: true, preservedOriginalLogin: true }));
    return 0;
  }
  if (action === 'expose') {
    const port = Number(options.port);
    if (!validPreviewPort(port)) throw new Error('Invalid preview port');
    if (options.postPaths?.some((path) => !validPreviewPostPath(path))) throw new Error('Invalid preview POST path; use an exact absolute path without query, encoding or dot segments');
    if (options.requestHeaders?.some((header) => !validPreviewRequestHeader(header))) throw new Error('Invalid preview request header; use a lowercase x- application header, excluding proxy address headers');
    if (routes[options.slug] && !options.replace) throw new Error('Preview slug already exists; pass --replace to update it');
    if (options.access && !['employee', 'basic'].includes(options.access)) throw new Error('Preview access must be employee or basic');
    if (!routes[options.slug] && options.access === 'basic' && await siteLoginConfigured()) {
      throw new Error('New internal websites must use employee login; remove the upstream password prompt and publish with --access employee');
    }
    const policy = await resolveSitePolicy({ access: options.access, ownerPersonId: options.owner, existing: routes[options.slug], legacyAccess: 'basic' });
    const employee = policy.access === 'employee';
    if (!await probeAuth(port, employee)) throw new Error(employee
      ? 'Employee preview upstream must be healthy without a second login; keep it loopback-only'
      : 'Preview service must require HTTP Basic authentication before exposure');
    routes[options.slug] = { port, ...(employee ? policy : {}) };
    if (options.postPaths?.length) routes[options.slug].postPaths = [...new Set(options.postPaths)];
    if (options.requestHeaders?.length) routes[options.slug].requestHeaders = [...new Set(options.requestHeaders)];
    await recordSiteOrigin({ kind: 'preview', slug: options.slug });
    await saveRoutes(routes);
    console.log(JSON.stringify({ slug: options.slug, port, url: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/preview/${options.slug}/` : `/preview/${options.slug}/` }));
    return 0;
  }
  if (action === 'unexpose') {
    delete routes[options.slug];
    await saveRoutes(routes);
    console.log(JSON.stringify({ slug: options.slug, removed: true }));
    return 0;
  }
  throw new Error(`Unknown preview action: ${action}`);
}
