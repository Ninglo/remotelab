import { PI_AGENT_DIR } from '../lib/config.mjs';
import {
  resolveCodexHomeDir,
  resolveMachineAccountHomeDir,
} from '../lib/codex-home.mjs';
import { readPromptAsset } from './prompt-asset-loader.mjs';

async function readInlinePromptAsset(relativePath) {
  return (await readPromptAsset(relativePath)).replace(/\s+/g, ' ').trim();
}

export const MANAGER_RUNTIME_BOUNDARY_SECTION = (await readPromptAsset('runtime/manager-boundary.md')).trim();
export const MANAGER_TURN_POLICY_REMINDER = await readInlinePromptAsset('runtime/manager-turn-reminder.txt');
export const DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS = await readInlinePromptAsset('runtime/codex-developer-instructions.txt');

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
