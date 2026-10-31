import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { CONFIG_DIR } from './config.mjs';

// Optional adapter for a loopback application whose old password exists only
// as a hash. The ingress verifies the employee and site scope; this independent
// capability authenticates only the gateway-to-upstream connection, never a user.
export async function previewUpstreamAuthorized(req, { configDir = CONFIG_DIR } = {}) {
  const supplied = req.headers.authorization;
  if (typeof supplied !== 'string' || !supplied.startsWith('Bearer ') || supplied.length > 4096) return false;
  try {
    const d = JSON.parse(await readFile(join(configDir, 'site-legacy-logins.json'), 'utf8'));
    return Object.values(d.sites || {}).some(binding => {
      if (!binding.upstreamToken || binding.port !== req.socket.localPort) return false;
      const a = Buffer.from(supplied), b = Buffer.from(binding.authorization);
      return a.length === b.length && timingSafeEqual(a, b);
    });
  } catch { return false; }
}
