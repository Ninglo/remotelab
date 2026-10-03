import { execFile } from 'node:child_process';
import { chmod, mkdir, realpath, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateWorkspace } from './memory-governance-preflight.mjs';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('./memory-governance-sandbox.sh', import.meta.url));

export async function runGovernanceSandbox({ workspace, protectedRoots }) {
  if (process.platform !== 'linux') throw new Error('Isolated collection requires Linux namespaces; no unrestricted fallback.');
  const { root } = await validateWorkspace(workspace, protectedRoots);
  const input = await realpath(join(root, 'input'));
  const output = await realpath(join(root, 'output'));
  if (dirname(input) !== root || dirname(output) !== root) throw new Error('Input/output cannot be aliases outside the test workspace.');
  const sandbox = join(root, 'sandbox');
  try { if ((await readdir(sandbox)).length) throw new Error('Sandbox root must be empty.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const lock = join(root, '.runner-lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    await mkdir(sandbox, { mode: 0o700 });
    await chmod(root, 0o700);
    const runtime = await realpath(process.execPath);
    return await exec('/usr/bin/unshare', [
      '--user', '--map-root-user', '--mount', '--net', '--pid', '--fork', '--kill-child',
      '/bin/bash', launcher, sandbox, input, output, runtime,
    ], {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
      timeout: 65000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    throw new Error('Isolated worker failed; no unrestricted retry: ' + String(e.stderr || e.message).slice(0, 1200));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
