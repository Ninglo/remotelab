import { spawn } from 'node:child_process';

// Only lock paths and request IDs enter this process. A pipe lifetime owns
// each kernel lock, as in the original helper.
const holders = new Map();
const reply = message => {
  if (process.connected) process.send(message, () => {});
};
process.on('message', ({ id, action, file }) => {
  if (action === 'release') {
    const holder = holders.get(id);
    if (holder) { holder.releasing = true; holder.child.stdin.end(); }
    return;
  }
  if (action !== 'acquire' || holders.has(id)) return;
  const child = spawn('flock', ['--exclusive', '--timeout', '30', `${file}.lock`,
    '/bin/sh', '-c', "printf 'locked\\n'; cat >/dev/null"], { stdio: ['pipe', 'pipe', 'pipe'] });
  const holder = { child, acquired: false, releasing: false, error: '' };
  holders.set(id, holder);
  let output = '';
  child.stdin.on('error', () => {});
  child.stderr.on('data', data => { holder.error = (holder.error + data).slice(-2000); });
  child.stdout.on('data', data => {
    output += data;
    if (!holder.acquired && output.includes('locked\n')) {
      holder.acquired = true; reply({ id, state: 'acquired' });
    }
  });
  child.on('error', error => { holder.error = error.message; });
  child.on('close', (code, signal) => {
    holders.delete(id);
    reply(holder.acquired && holder.releasing && code === 0
      ? { id, state: 'released' }
      : { id, error: holder.error || `lock holder exited (${signal || code})` });
  });
});
process.on('disconnect', () => {
  // SIGKILL/OOM of the parent closes IPC; never retain an orphaned writer lock.
  for (const holder of holders.values()) holder.child.stdin.end();
});
