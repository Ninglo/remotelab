import http from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PREVIEW_ROUTES_FILE, validPreviewPort, validPreviewSlug } from '../chat/preview-proxy.mjs';
import { PUBLIC_BASE_URL } from './config.mjs';

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
    else if (arg === '--slug' || arg === '--port') options[arg.slice(2)] = args[++i];
    else throw new Error(`Unknown preview option: ${arg}`);
  }
  return options;
}

function probeAuth(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'HEAD', timeout: 5000 }, (res) => {
      res.resume();
      const challenges = res.headers['www-authenticate'];
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
    console.log('Usage: remotelab preview expose --slug <name> --port <loopback-port> [--replace] [--json] | list [--json] | unexpose --slug <name> [--json]');
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
    if (routes[options.slug] && !options.replace) throw new Error('Preview slug already exists; pass --replace to update it');
    if (!await probeAuth(port)) throw new Error('Preview service must require HTTP Basic authentication before exposure');
    routes[options.slug] = { port };
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
