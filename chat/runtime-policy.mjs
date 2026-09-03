import { PI_AGENT_DIR } from '../lib/config.mjs';
import {
  resolveCodexHomeDir,
  resolveMachineAccountHomeDir,
} from '../lib/codex-home.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export { resolveCodexHomeDir, resolveMachineAccountHomeDir };

export function applyProviderRuntimeEnv(toolId, baseEnv = {}, options = {}) {
  const env = { ...baseEnv };
  const runtimeFamily = typeof options.runtimeFamily === 'string'
    ? options.runtimeFamily.trim()
    : '';
  if (toolId === 'pi' || runtimeFamily === 'pi-json') {
    env.PI_CODING_AGENT_DIR = trimString(process.env.REMOTELAB_MACHINE_PI_AGENT_DIR)
      || trimString(process.env.PI_CODING_AGENT_DIR)
      || PI_AGENT_DIR;
    return env;
  }
  const isCodexRuntime = toolId === 'codex'
    || runtimeFamily === 'codex-json';
  if (!isCodexRuntime) {
    return env;
  }
  env.CODEX_HOME = resolveCodexHomeDir();
  return env;
}
