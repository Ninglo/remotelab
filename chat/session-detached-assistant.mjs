import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { createToolInvocation, resolveCommand, resolveCwd } from './process-runner.mjs';

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

export async function runDetachedAssistantPrompt(sessionMeta, prompt, options = {}) {
  const {
    folder,
    tool,
    model,
    effort,
    thinking,
  } = sessionMeta;

  if (!tool) {
    throw new Error('Detached assistant prompt requires an explicit tool');
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  const invocation = await createToolInvocation(tool, prompt, {
    dangerouslySkipPermissions: true,
    model: options.model ?? model,
    effort: options.effort ?? effort,
    thinking: options.thinking ?? thinking,
    systemPrefix: Object.prototype.hasOwnProperty.call(options, 'systemPrefix')
      ? options.systemPrefix
      : '',
    developerInstructions: options.developerInstructions,
  });
  const resolvedCmd = await resolveCommand(invocation.command);
  const resolvedFolder = resolveCwd(folder);
  const env = buildToolProcessEnv(invocation.envOverrides || {});
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  return new Promise((resolve, reject) => {
    let settled = false;
    const proc = spawn(resolvedCmd, invocation.args, {
      cwd: resolvedFolder,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin.end();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 5000);
      reject(new Error(`Detached assistant prompt timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const rl = createInterface({ input: proc.stdout });
    const textParts = [];

    rl.on('line', (line) => {
      const events = invocation.adapter.parseLine(line);
      for (const evt of events) {
        if (evt.type === 'message' && evt.role === 'assistant') {
          textParts.push(evt.content || '');
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const raw = textParts.join('\n').trim();
      if (code !== 0 && !raw) {
        reject(new Error(`${tool} exited with code ${code}`));
        return;
      }
      resolve(raw);
    });
  });
}
