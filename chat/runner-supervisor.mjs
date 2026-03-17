import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CHAT_PORT } from '../lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerEntry = join(__dirname, 'runner-sidecar.mjs');

export function spawnDetachedRunner(runId) {
  const child = spawn(process.execPath, [runnerEntry, runId], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      REMOTELAB_CHAT_BASE_URL: process.env.REMOTELAB_CHAT_BASE_URL || `http://127.0.0.1:${CHAT_PORT}`,
    },
  });
  child.unref();
  return { pid: child.pid };
}
