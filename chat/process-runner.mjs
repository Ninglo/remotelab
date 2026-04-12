import { createClaudeAdapter, buildClaudeArgs } from './adapters/claude.mjs';
import { createCodexAdapter, buildCodexArgs } from './adapters/codex.mjs';
import { expandSessionFolder } from './session-folder.mjs';
import {
  buildToolProcessEnvOverrides,
  getToolDefinitionAsync,
  getToolCommandAsync,
  resolveToolCommandPathAsync,
} from '../lib/tools.mjs';
import {
  formatAttachmentContextReference,
  getAttachmentSavedPath,
} from './attachment-utils.mjs';
import { pathExists } from './fs-utils.mjs';

export function resolveCwd(folder) {
  return expandSessionFolder(folder);
}

const TAG = '[process-runner]';

/**
 * Resolve a command name to its full absolute path.
 */
export async function resolveCommand(cmd) {
  const resolved = await resolveToolCommandPathAsync(cmd);
  if (resolved && await pathExists(resolved)) {
    console.log(`${TAG} Resolved "${cmd}" → ${resolved}`);
    return resolved;
  }
  console.log(`${TAG} Could not resolve "${cmd}", using bare name`);
  return cmd;
}

export function buildRuntimeInvocation(runtimeFamily, prompt, options = {}, toolId = 'unknown') {
  const normalizedRuntimeFamily = typeof runtimeFamily === 'string' ? runtimeFamily.trim() : '';
  if (!normalizedRuntimeFamily) {
    throw new Error(`Tool "${toolId}" is missing runtimeFamily`);
  }
  const allowDangerousPermissionSkip = String(process.env.IS_SANDBOX || '').trim() === '1'
    && options.dangerouslySkipPermissions;
  let adapter;
  let args;

  if (normalizedRuntimeFamily === 'claude-stream-json') {
    adapter = createClaudeAdapter();
    args = buildClaudeArgs(prompt, {
      dangerouslySkipPermissions: allowDangerousPermissionSkip,
      resume: options.claudeSessionId,
      maxTurns: options.maxTurns,
      continue: options.continue,
      allowedTools: options.allowedTools,
      thinking: options.thinking,
      model: options.model,
      effort: options.effort,
    });
  } else if (normalizedRuntimeFamily === 'codex-json') {
    adapter = createCodexAdapter();
    args = buildCodexArgs(prompt, {
      threadId: options.codexThreadId,
      model: options.model,
      reasoningEffort: options.effort,
      developerInstructions: options.developerInstructions,
      systemPrefix: options.systemPrefix,
    });
  } else {
    throw new Error(`Tool "${toolId}" uses unsupported runtimeFamily "${normalizedRuntimeFamily}"`);
  }

  return {
    adapter,
    args,
    isClaudeFamily: normalizedRuntimeFamily === 'claude-stream-json',
    isCodexFamily: normalizedRuntimeFamily === 'codex-json',
    runtimeFamily: normalizedRuntimeFamily,
  };
}

export async function createToolInvocation(toolId, prompt, options = {}) {
  const tool = await getToolDefinitionAsync(toolId);
  const command = tool?.command || await getToolCommandAsync(toolId);
  const envOverrides = buildToolProcessEnvOverrides(tool || { id: toolId });
  const runtimeFamily = tool?.runtimeFamily
    || (toolId === 'claude' ? 'claude-stream-json' : toolId === 'codex' ? 'codex-json' : null);
  const runtimeInvocation = buildRuntimeInvocation(runtimeFamily, prompt, options, toolId);

  return {
    command,
    envOverrides,
    ...runtimeInvocation,
  };
}

function describeAttachmentLabel(attachment) {
  const mimeType = typeof attachment?.mimeType === 'string' ? attachment.mimeType : '';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  return 'file';
}

export function prependAttachmentPaths(prompt, images) {
  const paths = (images || [])
    .map((img) => ({
      savedPath: getAttachmentSavedPath(img),
      reference: formatAttachmentContextReference(img),
      label: describeAttachmentLabel(img),
    }))
    .filter((entry) => entry.savedPath);
  if (paths.length === 0) return prompt;
  const refs = paths.map((entry) => `[User attached ${entry.label}: ${entry.reference}]`).join('\n');
  return `${refs}\n\n${prompt}`;
}
