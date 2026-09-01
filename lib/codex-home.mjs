import { userInfo } from 'node:os';
import { join } from 'node:path';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveMachineAccountHomeDir() {
  const homeDir = trimString(userInfo().homedir);
  if (!homeDir) {
    throw new Error('Unable to resolve the machine account home directory');
  }
  return homeDir;
}

export function resolveCodexHomeDir() {
  return trimString(process.env.REMOTELAB_MACHINE_CODEX_HOME)
    || join(resolveMachineAccountHomeDir(), '.codex');
}
