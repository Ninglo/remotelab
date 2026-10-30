import { resolveSitePolicy } from './site-publication-policy.mjs';
import http from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PREVIEW_ROUTES_FILE, validPreviewPort, validPreviewSlug, validPreviewPostPath, validPreviewRequestHeader } from '../chat/preview-proxy.mjs';
import { PUBLIC_BASE_URL } from './config.mjs';
import { recordSiteOrigin } from './site-directory.mjs';

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
    else if (arg === '--slug' || arg === '--port' || arg === '--access' || arg === '--owner') options[arg.slice(2)] = args[++i];
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
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'HEAD', timeout: 5000 }, (res) => {
      res.resume();
      const challenges = res.headers['www-authenticate'];
      if (employee) { resolve(res.statusCode >= 200 && res.statusCode < 400); return; }
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
    console.log('Usage: remotelab preview expose --slug <name> --port <loopback-port> [--access employee|basic] [--owner person-id] [--post-path /exact/path] [--forward-header x-app-header] [--replace] [--json] | list [--json] | unexpose --slug <name> [--json]');
    return 0;
  }
  const options = parseOptions(rest);
  if (action === 'list') {
    console.log(JSON.stringify(await readRoutes(), null, 2));
    return 0;
  }
  if (!validPreviewSlug(options.slug)) throw new Error('Invalid preview slug');
  const routes = await readRoutes();
  if (action === 'expose') {
    const port = Number(options.port);
    if (!validPreviewPort(port)) throw new Error('Invalid preview port');
    if (options.postPaths?.some((path) => !validPreviewPostPath(path))) throw new Error('Invalid preview POST path; use an exact absolute path without query, encoding or dot segments');
    if (options.requestHeaders?.some((header) => !validPreviewRequestHeader(header))) throw new Error('Invalid preview request header; use a lowercase x- application header, excluding proxy address headers');
    if (routes[options.slug] && !options.replace) throw new Error('Preview slug already exists; pass --replace to update it');
    if (options.access && !['employee', 'basic'].includes(options.access)) throw new Error('Preview access must be employee or basic');
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
