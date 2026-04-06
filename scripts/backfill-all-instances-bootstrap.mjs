#!/usr/bin/env node

/**
 * Backfill bootstrap sessions (including calendar guide) for all guest instances.
 * Each instance gets its own calendar feed token and subscription link.
 *
 * Usage: node scripts/backfill-all-instances-bootstrap.mjs
 */

import { readFile } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const guestInstancesPath = join(homedir(), '.config', 'remotelab', 'guest-instances.json');

let instances;
try {
  instances = JSON.parse(await readFile(guestInstancesPath, 'utf8'));
  if (!Array.isArray(instances)) instances = instances.instances || [];
} catch (err) {
  console.error('Failed to read guest-instances.json:', err.message);
  process.exit(1);
}

console.log(`Found ${instances.length} instances.\n`);

const results = [];

for (const inst of instances) {
  const name = inst.name || inst.id || '(unknown)';
  const instanceRoot = inst.instanceRoot || inst.root || join(homedir(), '.remotelab', 'instances', name);
  const port = inst.port;

  console.log(`[${name}] backfilling (port=${port}, root=${basename(instanceRoot)})...`);

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(projectRoot, 'scripts', 'backfill-owner-bootstrap.mjs')],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          REMOTELAB_INSTANCE_ROOT: instanceRoot,
          ...(port ? { CHAT_PORT: String(port) } : {}),
        },
        encoding: 'utf8',
        timeout: 30000,
      },
    );

    // Parse the JSON result from the child script
    const lines = stdout.trim().split('\n');
    const jsonStart = lines.findIndex((l) => l.startsWith('{'));
    if (jsonStart >= 0) {
      const result = JSON.parse(lines.slice(jsonStart).join('\n'));
      results.push({ name, status: 'ok', ...result });
      const created = result.created?.length || 0;
      const updated = result.updated?.length || 0;
      console.log(`  -> created: ${created}, updated: ${updated}`);
    } else {
      results.push({ name, status: 'ok', raw: stdout.trim() });
      console.log(`  -> done (no JSON output)`);
    }
  } catch (err) {
    results.push({ name, status: 'error', error: err.message });
    console.error(`  -> ERROR: ${err.message}`);
  }
}

console.log('\n--- Summary ---');
const ok = results.filter((r) => r.status === 'ok').length;
const errors = results.filter((r) => r.status === 'error').length;
console.log(`Total: ${results.length} | OK: ${ok} | Errors: ${errors}`);

if (errors > 0) {
  console.log('\nFailed instances:');
  for (const r of results.filter((r) => r.status === 'error')) {
    console.log(`  ${r.name}: ${r.error}`);
  }
}
