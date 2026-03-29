import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { readFile, appendFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { loadHistory } from './history.mjs';
import { createToolInvocation, resolveCommand, resolveCwd } from './process-runner.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { pathExists } from './fs-utils.mjs';

/**
 * Run a prompt via a tool using the haiku model for cheap/fast inference.
 * Returns the assistant response text, or null on failure.
 */
async function runHaikuPrompt(sessionMeta, prompt, { timeout = 45000 } = {}) {
  const tool = sessionMeta.tool || 'claude';
  const folder = sessionMeta.folder || '';
  const sessionId = sessionMeta.id || '(unknown)';

  const { command, adapter, args, envOverrides } = await createToolInvocation(tool, prompt, {
    dangerouslySkipPermissions: true,
    model: 'haiku',
    systemPrefix: '',
  });
  const resolvedCmd = await resolveCommand(command);
  const resolvedFolder = resolveCwd(folder);
  console.log(
    `[auto-distill] Calling tool=${tool} cmd=${resolvedCmd} model=haiku for session ${sessionId.slice(0, 8)}`
  );

  const subEnv = buildToolProcessEnv(envOverrides || {});
  delete subEnv.CLAUDECODE;
  delete subEnv.CLAUDE_CODE_ENTRYPOINT;

  return new Promise((resolve, reject) => {
    const proc = spawn(resolvedCmd, args, {
      cwd: resolvedFolder,
      env: subEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin.end();

    const rl = createInterface({ input: proc.stdout });
    const textParts = [];

    rl.on('line', (line) => {
      const events = adapter.parseLine(line);
      for (const evt of events) {
        if (evt.type === 'message' && evt.role === 'assistant') {
          textParts.push(evt.content || '');
        }
      }
    });

    proc.stderr.on('data', () => {});
    proc.on('error', (err) => {
      console.error(`[auto-distill] tool error for ${sessionId.slice(0, 8)}: ${err.message}`);
      reject(err);
    });
    proc.on('exit', (code) => {
      const raw = textParts.join('').trim();
      if (code !== 0 && !raw) {
        reject(new Error(`tool exited with code ${code}`));
        return;
      }
      resolve(raw || null);
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
  });
}

/**
 * Generate experience notes for a completed session using Haiku, then write
 * directly to the workspace's memory/<today>.md file.
 * Does NOT wake up the session — fully background operation.
 */
export async function runAutoDistill(sessionId, sessionMeta) {
  console.log(`[auto-distill] Start for session ${sessionId.slice(0, 8)}`);

  const allEvents = await loadHistory(sessionId, { includeBodies: true });
  if (allEvents.length === 0) {
    console.log(`[auto-distill] No history for ${sessionId.slice(0, 8)}, skipping`);
    return;
  }

  // Build a condensed view of the session
  const lines = [];
  for (const evt of allEvents.slice(-60)) {
    if (evt.type === 'message' && evt.role === 'user') {
      lines.push(`USER: ${(evt.content || '').slice(0, 300)}`);
    } else if (evt.type === 'message' && evt.role === 'assistant') {
      lines.push(`ASSISTANT: ${(evt.content || '').slice(0, 400)}`);
    } else if (evt.type === 'file_change') {
      lines.push(`FILE ${(evt.changeType || 'changed').toUpperCase()}: ${evt.filePath}`);
    }
  }
  const historyText = lines.join('\n').slice(0, 8000);

  const today = new Date().toISOString().slice(0, 10);
  const folder = sessionMeta.folder || '';
  const memoryPath = join(folder, 'memory', `${today}.md`);

  const prompt = [
    `Session folder: ${folder}`,
    `Session name: ${sessionMeta.name || '(unnamed)'}`,
    '',
    'Recent activity:',
    historyText,
    '',
    `Write 3-5 concise experience notes in Chinese to append to ${memoryPath}.`,
    'Format (plain markdown, no frontmatter):',
    '',
    `## Auto-distill ${sessionMeta.name || sessionId.slice(0, 8)}（${today}）`,
    '',
    '1. **做了什么**：一句话',
    '2. **踩了什么坑**：如无则省略',
    '3. **可复用的模式**：',
    '4. **遗留问题**：如无则省略',
    '',
    'Reply ONLY with the markdown block. No explanation.',
  ].join('\n');

  let result;
  try {
    result = await runHaikuPrompt(sessionMeta, prompt, { timeout: 45000 });
  } catch (err) {
    console.error(`[auto-distill] Haiku call failed for ${sessionId.slice(0, 8)}: ${err.message}`);
    return;
  }

  if (!result || !result.trim()) {
    console.log(`[auto-distill] Haiku returned empty for ${sessionId.slice(0, 8)}`);
    return;
  }

  // Ensure memory directory exists
  const memDir = dirname(memoryPath);
  await mkdir(memDir, { recursive: true });

  // Dedup: check if an identical distill heading already exists in the file
  const heading = result.trim().split('\n')[0];
  if (await pathExists(memoryPath)) {
    try {
      const existing = await readFile(memoryPath, 'utf8');
      if (existing.includes(heading)) {
        console.log(`[auto-distill] Skipping duplicate for ${sessionId.slice(0, 8)} (heading already exists)`);
        return;
      }
    } catch {}
  }

  await appendFile(memoryPath, '\n' + result.trim() + '\n', 'utf8');
  console.log(`[auto-distill] Wrote to ${memoryPath} for session ${sessionId.slice(0, 8)}`);
}
