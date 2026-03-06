import { spawn, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve, join } from 'path';
import { createInterface } from 'readline';
import { createClaudeAdapter, buildClaudeArgs } from './adapters/claude.mjs';
import { createCodexAdapter, buildCodexArgs } from './adapters/codex.mjs';
import { statusEvent } from './normalizer.mjs';
import { getToolDefinition, getToolCommand, fullPath } from '../lib/tools.mjs';

export function resolveCwd(folder) {
  if (!folder || folder === '~') return homedir();
  if (folder.startsWith('~/')) return join(homedir(), folder.slice(2));
  return resolve(folder);
}

const TAG = '[process-runner]';

/**
 * Resolve a command name to its full absolute path.
 */
export function resolveCommand(cmd) {
  const home = process.env.HOME || '';
  const isMac = process.platform === 'darwin';
  const preferred = [
    `${home}/.local/bin/${cmd}`,
    // macOS-specific paths
    ...(isMac ? [
      `${home}/Library/pnpm/${cmd}`,
      `/opt/homebrew/bin/${cmd}`,
    ] : [
      // Linux-specific paths
      `/snap/bin/${cmd}`,
    ]),
    `/usr/local/bin/${cmd}`,
    `/usr/bin/${cmd}`,
  ];
  for (const p of preferred) {
    if (p && existsSync(p)) {
      console.log(`${TAG} Resolved "${cmd}" → ${p} (preferred path)`);
      return p;
    }
  }

  try {
    const resolved = execFileSync('which', [cmd], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fullPath },
      timeout: 3000,
    }).trim();
    console.log(`${TAG} Resolved "${cmd}" → ${resolved} (which)`);
    return resolved;
  } catch {
    console.log(`${TAG} Could not resolve "${cmd}", using bare name`);
    return cmd;
  }
}

export function createToolInvocation(toolId, prompt, options = {}) {
  const tool = getToolDefinition(toolId);
  const command = tool?.command || getToolCommand(toolId);
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

  return { command, adapter, args, isClaudeFamily, isCodexFamily };
}

/**
 * Build a prompt with image file paths prepended.
 */
function prependImagePaths(prompt, images) {
  const paths = (images || []).map(img => img.savedPath).filter(Boolean);
  if (paths.length === 0) return prompt;
  const refs = paths.map(p => `[User attached image: ${p}]`).join('\n');
  return `${refs}\n\n${prompt}`;
}

/**
 * Max number of auto-continue attempts for Codex when a turn ends
 * but the last agent message indicates unfinished work.
 */
const CODEX_MAX_AUTO_CONTINUES = 3;

/**
 * Patterns in the last agent_message that suggest Codex planned work
 * but didn't actually execute it before ending the turn.
 */
const CODEX_UNFINISHED_PATTERNS = [
  /\bi(?:'ll|'ll| will)\b/i,
  /\bnext\b.*\b(?:i'll|let me|we'll)\b/i,
  /\bnow\b.*\b(?:i'll|let me)\b/i,
  /\blet me\b/i,
  /\bgoing to\b/i,
];

/**
 * Check whether the last agent message from Codex suggests it planned
 * further work but the turn ended before executing it.
 */
function codexTurnLooksIncomplete(lastAgentMessage, hadFileChanges, hadCommands) {
  if (!lastAgentMessage) return false;
  // If the turn actually produced file changes or multiple commands, it did real work
  if (hadFileChanges) return false;
  if (hadCommands >= 2) return false;
  // Check if the last message promises future actions
  return CODEX_UNFINISHED_PATTERNS.some(p => p.test(lastAgentMessage));
}

export function spawnTool(toolId, folder, prompt, onEvent, onExit, options = {}) {
  const hasImages = options.images && options.images.length > 0;

  // For all tools: prepend image file paths to prompt
  const effectivePrompt = hasImages ? prependImagePaths(prompt, options.images) : prompt;

  const { command, adapter, args, isClaudeFamily, isCodexFamily } = createToolInvocation(toolId, effectivePrompt, {
    dangerouslySkipPermissions: true,
    claudeSessionId: options.claudeSessionId,
    codexThreadId: options.codexThreadId,
    thinking: options.thinking,
    model: options.model,
    effort: options.effort,
  });

  const resolvedCmd = resolveCommand(command);
  const resolvedFolder = resolveCwd(folder);

  // Clean env: remove CLAUDECODE markers so nested Claude Code sessions work
  const cleanEnv = { ...process.env, PATH: fullPath };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  // Shared mutable state across potential auto-continue cycles
  const state = {
    proc: null,
    capturedClaudeSessionId: null,
    capturedCodexThreadId: null,
    cancelled: false,
    autoContinueCount: 0,
  };

  function spawnProcess(spawnArgs) {
    console.log(`${TAG} Spawning: ${resolvedCmd}`);
    console.log(`${TAG}   args: ${JSON.stringify(spawnArgs)}`);
    console.log(`${TAG}   cwd: ${folder} → ${resolvedFolder}`);
    console.log(`${TAG}   prompt: ${prompt?.slice(0, 100)}`);
    if (hasImages) console.log(`${TAG}   images: ${options.images.length}`);

    const proc = spawn(resolvedCmd, spawnArgs, {
      cwd: resolvedFolder,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });
    state.proc = proc;

    console.log(`${TAG} Process spawned, pid=${proc.pid}`);

    const rl = createInterface({ input: proc.stdout });
    let lineCount = 0;

    // Track Codex turn content for auto-continue detection
    let lastAgentMessage = null;
    let turnFileChanges = 0;
    let turnCommands = 0;

    rl.on('line', (line) => {
      lineCount++;
      console.log(`${TAG} [stdout#${lineCount}] ${line.slice(0, 300)}`);

      // Capture session/thread IDs for conversation resumption
      try {
        const obj = JSON.parse(line);
        if (isClaudeFamily && !state.capturedClaudeSessionId && obj.session_id) {
          state.capturedClaudeSessionId = obj.session_id;
          console.log(`${TAG} Captured Claude session_id: ${state.capturedClaudeSessionId}`);
          options.onResumeIds?.({ claudeSessionId: state.capturedClaudeSessionId });
        }
        if (isCodexFamily && !state.capturedCodexThreadId && obj.type === 'thread.started' && obj.thread_id) {
          state.capturedCodexThreadId = obj.thread_id;
          console.log(`${TAG} Captured Codex thread_id: ${state.capturedCodexThreadId}`);
          options.onResumeIds?.({ codexThreadId: state.capturedCodexThreadId });
        }

        // Track what this turn actually did
        if (isCodexFamily && obj.type === 'item.completed' && obj.item) {
          if (obj.item.type === 'agent_message') lastAgentMessage = obj.item.text || '';
          if (obj.item.type === 'file_change') turnFileChanges++;
          if (obj.item.type === 'command_execution') turnCommands++;
        }
      } catch {}

      const events = adapter.parseLine(line);
      console.log(`${TAG}   → parsed ${events.length} event(s): ${events.map(e => e.type).join(', ') || '(none)'}`);
      for (const evt of events) {
        onEvent(evt);
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.log(`${TAG} [stderr] ${text.slice(0, 500)}`);
      }
    });

    proc.on('error', (err) => {
      console.error(`${TAG} Process error: ${err.message} (code=${err.code})`);
      onEvent(statusEvent(`process error: ${err.message}`));
      onExit(1);
    });

    proc.on('exit', (code, signal) => {
      console.log(`${TAG} Process exited: code=${code}, signal=${signal}, lines=${lineCount}`);
      const remaining = adapter.flush();
      if (remaining.length > 0) {
        console.log(`${TAG} Flushed ${remaining.length} remaining event(s)`);
        for (const evt of remaining) {
          onEvent(evt);
        }
      }

      // Codex auto-continue: if the turn ended cleanly but work looks incomplete,
      // automatically resume with a "continue" prompt.
      if (
        isCodexFamily &&
        !state.cancelled &&
        code === 0 &&
        state.capturedCodexThreadId &&
        state.autoContinueCount < CODEX_MAX_AUTO_CONTINUES &&
        codexTurnLooksIncomplete(lastAgentMessage, turnFileChanges, turnCommands)
      ) {
        state.autoContinueCount++;
        console.log(`${TAG} Codex turn looks incomplete (attempt ${state.autoContinueCount}/${CODEX_MAX_AUTO_CONTINUES}), auto-continuing...`);
        console.log(`${TAG}   lastMsg: "${lastAgentMessage?.slice(0, 120)}"`);
        console.log(`${TAG}   fileChanges=${turnFileChanges}, commands=${turnCommands}`);

        onEvent(statusEvent(`auto-continuing (${state.autoContinueCount}/${CODEX_MAX_AUTO_CONTINUES})...`));

        const continueArgs = buildCodexArgs('Continue. Complete all remaining work now.', {
          threadId: state.capturedCodexThreadId,
        });
        spawnProcess(continueArgs);
        return;
      }

      onExit(code ?? 1);
    });

    proc.stdin.end();
  }

  // Initial spawn
  spawnProcess(args);

  return {
    get proc() { return state.proc; },
    toolId,
    get claudeSessionId() { return state.capturedClaudeSessionId; },
    get codexThreadId() { return state.capturedCodexThreadId; },
    cancel() {
      state.cancelled = true;
      console.log(`${TAG} Killing process pid=${state.proc?.pid}`);
      try {
        state.proc?.kill('SIGTERM');
      } catch {}
    },
  };
}
