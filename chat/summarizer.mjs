import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { SIDEBAR_STATE_FILE } from '../lib/config.mjs';
import { loadHistory } from './history.mjs';
import { fullPath } from '../lib/tools.mjs';
import { createToolInvocation, resolveCommand, resolveCwd } from './process-runner.mjs';
import { broadcastAll } from './ws-clients.mjs';
import { isSessionAutoRenamePending } from './session-naming.mjs';

function loadSidebarState() {
  try {
    if (!existsSync(SIDEBAR_STATE_FILE)) return { sessions: {} };
    return JSON.parse(readFileSync(SIDEBAR_STATE_FILE, 'utf8'));
  } catch {
    return { sessions: {} };
  }
}

function saveSidebarState(state) {
  const dir = dirname(SIDEBAR_STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SIDEBAR_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Extract events belonging to the last turn (from the last user message onward).
 */
function extractLastTurn(events) {
  let lastUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'message' && events[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  return lastUserIdx === -1 ? events : events.slice(lastUserIdx);
}

/**
 * Format the last turn's events into a concise text block for the LLM prompt.
 * Skips reasoning/usage/status noise, caps lengths to keep context bounded.
 */
function formatTurnForPrompt(events) {
  const lines = [];
  for (const evt of events) {
    switch (evt.type) {
      case 'message':
        if (evt.role === 'user') {
          lines.push(`USER: ${(evt.content || '').slice(0, 400)}`);
        } else if (evt.role === 'assistant') {
          lines.push(`ASSISTANT: ${(evt.content || '').slice(0, 600)}`);
        }
        break;
      case 'file_change':
        lines.push(`FILE ${(evt.changeType || 'changed').toUpperCase()}: ${evt.filePath}`);
        break;
      case 'tool_use':
        lines.push(`TOOL CALLED: ${evt.toolName}`);
        break;
    }
  }
  return lines.join('\n');
}

/**
 * Trigger a non-blocking summary generation after a session turn completes.
 * sessionMeta: { id, folder, name, tool?, model?, effort?, thinking? }
 * onRename: optional callback (newName: string) => void — called when a better name is generated
 * options.updateSidebar: whether to persist sidebar state (default true)
 */
export function triggerSummary(sessionMeta, onRename, options = {}) {
  console.log(`[summarizer] triggerSummary called for session ${sessionMeta.id?.slice(0, 8)}`);
  return runSummary(sessionMeta, onRename, options).catch(err => {
    console.error(`[summarizer] Unexpected error for ${sessionMeta.id?.slice(0, 8)}: ${err.message}`);
    return {
      ok: false,
      error: err.message,
      rename: { attempted: false, renamed: false },
    };
  });
}

async function runSummary(sessionMeta, onRename, options = {}) {
  const {
    id: sessionId,
    folder,
    name,
    autoRenamePending,
    tool = 'claude',
    model,
    effort,
    thinking,
  } = sessionMeta;

  const allEvents = loadHistory(sessionId);
  if (allEvents.length === 0) {
    console.log(`[summarizer] Skipping ${sessionId.slice(0, 8)}: no history events`);
    return {
      ok: false,
      skipped: 'no_history',
      rename: { attempted: false, renamed: false },
    };
  }

  const lastTurnEvents = extractLastTurn(allEvents);
  const turnText = formatTurnForPrompt(lastTurnEvents);
  if (!turnText.trim()) {
    console.log(`[summarizer] Skipping ${sessionId.slice(0, 8)}: empty turn text (${lastTurnEvents.length} events)`);
    return {
      ok: false,
      skipped: 'empty_turn',
      rename: { attempted: false, renamed: false },
    };
  }

  const state = loadSidebarState();
  const prevBackground = state.sessions[sessionId]?.background || '';

  const shouldGenerateTitle = isSessionAutoRenamePending({ name, autoRenamePending });
  const prompt = [
    'You are updating a developer\'s session status board. Be extremely concise.',
    '',
    `Session folder: ${folder}`,
    `Session name: ${name || '(unnamed)'}`,
    shouldGenerateTitle && name ? 'The current session name is only a temporary draft. Generate a better final title.' : '',
    prevBackground ? `Previous background: ${prevBackground}` : '',
    '',
    'Last turn:',
    turnText,
    '',
    'Write a JSON object with exactly these fields:',
    '- "background": One sentence — what is this session working on overall? Update if this turn changes the focus.',
    '- "lastAction": One sentence — the single most important thing that just happened.',
    shouldGenerateTitle ? '- "title": 2-5 words — a short descriptive title for this session (e.g. "Fix auth bug", "Add dark mode", "Refactor API layer"). No quotes around the title.' : '',
    '',
    'Respond with ONLY valid JSON. No markdown, no explanation.',
  ].filter(l => l !== null && l !== '').join('\n');

  const { command, adapter, args } = createToolInvocation(tool, prompt, {
    dangerouslySkipPermissions: true,
    model,
    effort,
    thinking,
    systemPrefix: '',
  });
  const resolvedCmd = resolveCommand(command);
  const resolvedFolder = resolveCwd(folder);
  console.log(
    `[summarizer] Calling tool=${tool} cmd=${resolvedCmd} model=${model || 'default'} effort=${effort || 'default'} thinking=${!!thinking} for session ${sessionId.slice(0, 8)}`
  );

  const subEnv = { ...process.env, PATH: fullPath };
  delete subEnv.CLAUDECODE;
  delete subEnv.CLAUDE_CODE_ENTRYPOINT;

  const modelText = await new Promise((resolve, reject) => {
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

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[summarizer] stderr: ${text.slice(0, 200)}`);
    });

    proc.on('error', (err) => {
      console.error(`[summarizer] ${tool} summary error for ${sessionId.slice(0, 8)}: ${err.message}`);
      reject(err);
    });

    proc.on('exit', (code) => {
      const remaining = adapter.flush();
      for (const evt of remaining) {
        if (evt.type === 'message' && evt.role === 'assistant') textParts.push(evt.content || '');
      }
      if (code !== 0 && textParts.length === 0) {
        reject(new Error(`${tool} exited with code ${code}`));
      } else {
        resolve(textParts.join(''));
      }
    });
  });

  // The model text itself should be a JSON object
  let summary;
  try {
    summary = JSON.parse(modelText);
  } catch {
    // Try to extract JSON from the text if wrapped in backticks or similar
    const jsonMatch = modelText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { summary = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
    }
  }

  if (!summary?.background || !summary?.lastAction) {
    console.error(`[summarizer] Unexpected model output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Unexpected model output: ${modelText.slice(0, 200)}`,
      rename: shouldGenerateTitle
        ? { attempted: true, renamed: false, error: 'Unexpected model output' }
        : { attempted: false, renamed: false },
    };
  }

  if (options.updateSidebar !== false) {
    state.sessions[sessionId] = {
      name: name || '',
      folder,
      background: summary.background,
      lastAction: summary.lastAction,
      updatedAt: Date.now(),
    };
    saveSidebarState(state);
    broadcastAll({ type: 'sidebar_update', state });
    console.log(`[summarizer] Updated sidebar for session ${sessionId.slice(0, 8)}: ${summary.lastAction}`);
  }

  // Auto-rename session if it still has a pending temporary/default name and a title was generated
  let rename = { attempted: shouldGenerateTitle, renamed: false };
  if (onRename && summary.title && shouldGenerateTitle) {
    const newName = summary.title.trim();
    if (newName) {
      console.log(`[summarizer] Auto-renaming session ${sessionId.slice(0, 8)} to: ${newName}`);
      const renamed = onRename(newName);
      rename = renamed
        ? { attempted: true, renamed: true, title: newName }
        : { attempted: true, renamed: false, error: 'Auto-rename no longer needed' };
    } else {
      rename = { attempted: true, renamed: false, error: 'Empty title generated' };
    }
  } else if (shouldGenerateTitle) {
    rename = { attempted: true, renamed: false, error: 'No title generated' };
  }

  return { ok: true, summary, rename };
}

export function getSidebarState() {
  return loadSidebarState();
}

export function removeSidebarEntry(sessionId) {
  const state = loadSidebarState();
  if (state.sessions[sessionId]) {
    delete state.sessions[sessionId];
    saveSidebarState(state);
  }
}

export function renameSidebarEntry(sessionId, name) {
  const state = loadSidebarState();
  if (!state.sessions[sessionId]) return false;
  state.sessions[sessionId] = {
    ...state.sessions[sessionId],
    name,
  };
  saveSidebarState(state);
  broadcastAll({ type: 'sidebar_update', state });
  return true;
}
