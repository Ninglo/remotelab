import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const [stat, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (fields[0] === 'Z' || fields[0] === 'X') return null;
      return { pid, birth: `${bootId.trim()}:${fields[19]}` };
    }
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 2000 });
    return stdout.trim() ? { pid, birth: stdout.trim() } : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH' || error.code === 1) return null;
    throw error;
  }
}

export async function isProcessIdentityAlive(identity) {
  if (!identity?.birth) return false;
  const current = await readProcessIdentity(identity.pid);
  return current?.birth === identity.birth;
}
