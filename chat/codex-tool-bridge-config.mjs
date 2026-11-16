import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url));

export function codexToolBridgeScriptPath() {
  return join(MODULE_DIR, 'codex-tool-bridge.mjs');
}

export function buildCodexToolBridgeOverrides({ nodePath = process.execPath, scriptPath = codexToolBridgeScriptPath() } = {}) {
  if (typeof nodePath !== 'string' || !nodePath.trim()) throw new TypeError('Codex tool bridge requires a Node executable path');
  if (typeof scriptPath !== 'string' || !scriptPath.trim()) throw new TypeError('Codex tool bridge requires a script path');
  return [
    `mcp_servers.remotelab.command=${JSON.stringify(nodePath)}`,
    `mcp_servers.remotelab.args=[${JSON.stringify(scriptPath)}]`,
  ];
}
