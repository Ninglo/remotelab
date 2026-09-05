import { resolve } from 'path';

const INHERITED_INSTANCE_ENV_KEYS = [
  'REMOTELAB_INSTANCE_ROOT',
  'REMOTELAB_CONFIG_DIR',
  'REMOTELAB_MEMORY_DIR',
  'REMOTELAB_MACHINE_CODEX_HOME',
  'REMOTELAB_MACHINE_PI_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
];

export function setIsolatedTestHome(home) {
  const normalizedHome = typeof home === 'string' ? home.trim() : '';
  if (!normalizedHome) throw new Error('A test home is required');

  process.env.HOME = resolve(normalizedHome);
  for (const key of INHERITED_INSTANCE_ENV_KEYS) delete process.env[key];
  process.env.REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
}
