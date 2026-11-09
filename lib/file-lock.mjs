import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// An OS lock is released even on OOM/SIGKILL. It protects the entire read-modify-
// commit, including offline tools. Linux record catalogs explicitly require flock.
export async function withFileLock(file, operation) {
  await mkdir(dirname(file), { recursive: true });
  const child = spawn('flock', ['--exclusive', '--timeout', '30', `${file}.lock`, process.execPath,
    '-e', "process.stdout.write('locked\\n');process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'pipe'] });
  let error = '', acquired = false;
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Register rejection handling immediately even if acquisition fails first.
  closed.catch(() => {});
  child.stderr.on('data', data => { error = (error + data).slice(-2000); });
  child.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', data => { output += data; if (output.includes('locked\n')) { acquired = true; resolve(); } });
      child.once('error', reject);
      child.once('close', () => { if (!acquired) reject(new Error(`FILE_LOCK_UNAVAILABLE: ${error}`)); });
    });
    return await operation();
  } finally { child.stdin.end(); await closed; }
}
