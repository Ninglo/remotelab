import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PUBLIC_PAGES_DIR } from '../lib/config.mjs';
import { requireEmployeeSite } from './employee-site-auth.mjs';

// This runs before static resolution, including JSON, images and downloads.
export async function checkEmployeeStaticAccess(req, res, pathname, root = PUBLIC_PAGES_DIR) {
  if (!pathname.startsWith('/public-pages/')) return false;
  const slug = pathname.split('/')[2];
  if (!slug || !/^[a-z0-9][a-z0-9._-]*$/.test(slug) || slug === '..') return false;
  let policy;
  try { policy = JSON.parse(await readFile(join(root, slug, '_remote_publish.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return false; // Existing unmanaged publications remain unchanged.
    res.writeHead(503, { 'Cache-Control': 'no-store' }); res.end('Site configuration unavailable'); return true;
  }
  if (policy.access !== 'employee') return false;
  if (!await requireEmployeeSite(req, res)) return true;
  req.employeeStaticPage = true;
  return false;
}
