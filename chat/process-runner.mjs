import { homedir } from 'os';
import { resolve, join } from 'path';
import { createClaudeAdapter, buildClaudeArgs } from './adapters/claude.mjs';
import { createCodexAdapter, buildCodexArgs } from './adapters/codex.mjs';
import { getToolDefinitionAsync, getToolCommandAsync, resolveToolCommandPathAsync } from '../lib/tools.mjs';
import { pathExists } from './fs-utils.mjs';

export function resolveCwd(folder) {
  if (!folder || folder === '~') return homedir();
  if (folder.startsWith('~/')) return join(homedir(), folder.slice(2));
  return resolve(folder);
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

export async function createToolInvocation(toolId, prompt, options = {}) {
  const tool = await getToolDefinitionAsync(toolId);
  const command = tool?.command || await getToolCommandAsync(toolId);
  const runtimeFamily = tool?.runtimeFamily
    || (toolId === 'claude' ? 'claude-stream-json' : toolId === 'codex' ? 'codex-json' : null);
  const isClaudeFamily = runtimeFamily === 'claude-stream-json';
  const isCodexFamily = runtimeFamily === 'codex-json';

  let adapter;
  let args;

  if (isClaudeFamily) {
    adapter = createClaudeAdapter();
    args = buildClaudeArgs(prompt, {
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      resume: options.claudeSessionId,
      maxTurns: options.maxTurns,
      continue: options.continue,
      allowedTools: options.allowedTools,
      thinking: options.thinking,
      model: options.model,
    });
  } else if (isCodexFamily) {
    adapter = createCodexAdapter();
    args = buildCodexArgs(prompt, {
      threadId: options.codexThreadId,
      model: options.model,
      reasoningEffort: options.effort,
      developerInstructions: options.developerInstructions,
      systemPrefix: options.systemPrefix,
    });
  } else {
    adapter = createClaudeAdapter();
    args = buildClaudeArgs(prompt, {
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      maxTurns: options.maxTurns,
      continue: options.continue,
      allowedTools: options.allowedTools,
      thinking: options.thinking,
      model: options.model,
    });
  }

  return {
    command,
    adapter,
    args,
    isClaudeFamily,
    isCodexFamily,
    runtimeFamily,
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
    .map((img) => ({ savedPath: img?.savedPath, label: describeAttachmentLabel(img) }))
    .filter((entry) => entry.savedPath);
  if (paths.length === 0) return prompt;
  const refs = paths.map((entry) => `[User attached ${entry.label}: ${entry.savedPath}]`).join('\n');
  return `${refs}\n\n${prompt}`;
}
