import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { dirname } from 'path';
import { SIDEBAR_STATE_FILE } from '../lib/config.mjs';
import { readLastTurnEvents } from './history.mjs';
import { fullPath } from '../lib/tools.mjs';
import { createToolInvocation, resolveCommand, resolveCwd } from './process-runner.mjs';
import { broadcastOwners } from './ws-clients.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';

function broadcastSidebarInvalidation() {
  broadcastOwners({ type: 'sidebar_invalidated' });
}
import {
  normalizeGeneratedSessionTitle,
  isSessionAutoRenamePending,
  normalizeSessionDescription,
  normalizeSessionGroup,
} from './session-naming.mjs';
import { loadSessionLabelPromptContext } from './session-label-context.mjs';

async function loadSidebarState() {
  const loaded = await readJson(SIDEBAR_STATE_FILE, { sessions: {} });
  return loaded && typeof loaded === 'object' ? loaded : { sessions: {} };
}

async function saveSidebarState(state) {
  const dir = dirname(SIDEBAR_STATE_FILE);
  await ensureDir(dir);
  await writeJsonAtomic(SIDEBAR_STATE_FILE, state);
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
 * sessionMeta: { id, folder, name, group?, description?, tool?, model?, effort?, thinking? }
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

export function triggerSessionLabelSuggestion(sessionMeta, onRename, options = {}) {
  console.log(`[summarizer] triggerSessionLabelSuggestion called for session ${sessionMeta.id?.slice(0, 8)}`);
  return runSessionLabelSuggestion(sessionMeta, onRename, options).catch(err => {
    console.error(`[summarizer] Session label suggestion error for ${sessionMeta.id?.slice(0, 8)}: ${err.message}`);
    return {
      ok: false,
      error: err.message,
      rename: { attempted: false, renamed: false },
    };
  });
}

async function runToolJsonPrompt(sessionMeta, prompt) {
  const {
    id: sessionId,
    folder,
    tool = 'claude',
    model,
    effort,
    thinking,
  } = sessionMeta;

  const { command, adapter, args } = await createToolInvocation(tool, prompt, {
    dangerouslySkipPermissions: true,
    model,
    effort,
    thinking,
    systemPrefix: '',
  });
  const resolvedCmd = await resolveCommand(command);
  const resolvedFolder = resolveCwd(folder);
  console.log(
    `[summarizer] Calling tool=${tool} cmd=${resolvedCmd} model=${model || 'default'} effort=${effort || 'default'} thinking=${!!thinking} for session ${sessionId.slice(0, 8)}`
  );

  const subEnv = { ...process.env, PATH: fullPath };
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

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[summarizer] stderr: ${text.slice(0, 200)}`);
    });

    proc.on('error', (err) => {
      console.error(`[summarizer] ${tool} structured prompt error for ${sessionId.slice(0, 8)}: ${err.message}`);
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
}

function parseJsonObject(modelText) {
  try {
    return JSON.parse(modelText);
  } catch {
    const jsonMatch = modelText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

async function runSessionLabelSuggestion(sessionMeta, onRename, options = {}) {
  const {
    id: sessionId,
    folder,
    name,
    group,
    description,
    autoRenamePending,
  } = sessionMeta;

  const shouldGenerateTitle = isSessionAutoRenamePending({ name, autoRenamePending });
  const currentGroup = normalizeSessionGroup(group || '');
  const currentDescription = normalizeSessionDescription(description || '');
  const shouldGenerateGrouping = !currentGroup || !currentDescription;
  if (!shouldGenerateTitle && !shouldGenerateGrouping) {
    return {
      ok: true,
      skipped: 'session_labels_not_needed',
      rename: { attempted: false, renamed: false },
    };
  }

  const lastTurnEvents = await readLastTurnEvents(sessionId, { includeBodies: true });
  if (lastTurnEvents.length === 0) {
    console.log(`[summarizer] Skipping session label suggestion for ${sessionId.slice(0, 8)}: no history events`);
    return {
      ok: false,
      skipped: 'no_history',
      rename: { attempted: false, renamed: false },
    };
  }

  const turnText = formatTurnForPrompt(lastTurnEvents);
  if (!turnText.trim()) {
    console.log(`[summarizer] Skipping session label suggestion for ${sessionId.slice(0, 8)}: empty turn text`);
    return {
      ok: false,
      skipped: 'empty_turn',
      rename: { attempted: false, renamed: false },
    };
  }

  const state = await loadSidebarState();
  const previousEntry = state.sessions[sessionId] || {};
  const promptContext = await loadSessionLabelPromptContext({
    ...sessionMeta,
    description: currentDescription || previousEntry.description || '',
  }, turnText);

  const prompt = [
    'You are naming a developer session. Be concise and literal.',
    'Treat the display group as a flexible project-like container: usually the top-level project or recurring domain. The title should name the concrete subtask inside that group.',
    'Reuse an existing display group when the scope clearly matches. Create a new group only when the work clearly belongs to a different project or domain.',
    'The latest turn may be underspecified. Use earlier session context, scope-router hints, and existing session metadata to infer the right top-level project before naming.',
    '',
    `Session folder: ${folder}`,
    `Current session name: ${name || '(unnamed)'}`,
    currentGroup ? `Current display group: ${currentGroup}` : '',
    currentDescription ? `Current session description: ${currentDescription}` : '',
    previousEntry.background ? `Previous session background: ${previousEntry.background}` : '',
    promptContext.contextSummary ? `Earlier session context:\n${promptContext.contextSummary}` : '',
    promptContext.scopeRouter ? `Known scope router entries:\n${promptContext.scopeRouter}` : '',
    promptContext.existingSessions ? `Current non-archived sessions:\n${promptContext.existingSessions}` : '',
    shouldGenerateTitle ? 'The current name is only a temporary draft. Generate a better final title based mainly on the latest user request.' : '',
    shouldGenerateGrouping ? 'Also generate a stable one-level display group for sidebar organization. This is not a filesystem path.' : '',
    shouldGenerateTitle ? 'The display group is shown separately in the UI. The title must focus on the specific task inside that group and should not repeat the group/domain words unless disambiguation truly requires it.' : '',
    '',
    'Latest turn:',
    turnText,
    '',
    'Write a JSON object with exactly these fields:',
    shouldGenerateTitle ? '- "title": 2-5 words — a short descriptive session title (for example: "Fix auth bug", "Refactor naming flow").' : '',
    shouldGenerateGrouping ? '- "group": 1-3 words — a stable display group for similar work (for example: "RemoteLab", "Video tooling", "Hiring"). Not a path.' : '',
    shouldGenerateGrouping ? '- "description": One sentence — a compact hidden description of the work, useful for future regrouping.' : '',
    '',
    'Respond with ONLY valid JSON. No markdown, no explanation.',
  ].filter(line => line !== '').join('\n');

  const modelText = await runToolJsonPrompt(sessionMeta, prompt);
  const labelResult = parseJsonObject(modelText);
  if (shouldGenerateTitle && !labelResult?.title) {
    console.error(`[summarizer] Unexpected title output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Unexpected model output: ${modelText.slice(0, 200)}`,
      rename: { attempted: true, renamed: false, error: 'Unexpected model output' },
    };
  }

  const earlySummary = {};
  if (shouldGenerateGrouping) {
    const nextGroup = normalizeSessionGroup(labelResult?.group || '');
    const nextDescription = normalizeSessionDescription(labelResult?.description || '');
    if (nextGroup) {
      earlySummary.group = nextGroup;
    }
    if (nextDescription) {
      earlySummary.description = nextDescription;
    }
  }

  if (!shouldGenerateTitle) {
    return {
      ok: true,
      ...(Object.keys(earlySummary).length > 0 ? { summary: earlySummary } : {}),
      rename: { attempted: false, renamed: false },
    };
  }

  if (!onRename) {
    return {
      ok: true,
      title: labelResult.title,
      ...(Object.keys(earlySummary).length > 0 ? { summary: earlySummary } : {}),
      rename: { attempted: true, renamed: false, error: 'No rename callback provided' },
    };
  }

  const finalGroup = normalizeSessionGroup(earlySummary.group || currentGroup || '');
  const newName = normalizeGeneratedSessionTitle(labelResult.title, finalGroup);
  if (!newName) {
    return {
      ok: false,
      error: 'Empty title generated',
      rename: { attempted: true, renamed: false, error: 'Empty title generated' },
    };
  }

  const renamed = await onRename(newName);
  return {
    ok: true,
    title: newName,
    ...(Object.keys(earlySummary).length > 0 ? { summary: earlySummary } : {}),
    rename: renamed
      ? { attempted: true, renamed: true, title: newName }
      : { attempted: true, renamed: false, error: options.skipReason || 'Auto-rename no longer needed' },
  };
}

async function runSummary(sessionMeta, onRename, options = {}) {
  const {
    id: sessionId,
    folder,
    name,
    group,
    description,
    autoRenamePending,
    tool = 'claude',
    model,
    effort,
    thinking,
  } = sessionMeta;

  const lastTurnEvents = await readLastTurnEvents(sessionId, { includeBodies: true });
  if (lastTurnEvents.length === 0) {
    console.log(`[summarizer] Skipping ${sessionId.slice(0, 8)}: no history events`);
    return {
      ok: false,
      skipped: 'no_history',
      rename: { attempted: false, renamed: false },
    };
  }

  const turnText = formatTurnForPrompt(lastTurnEvents);
  if (!turnText.trim()) {
    console.log(`[summarizer] Skipping ${sessionId.slice(0, 8)}: empty turn text (${lastTurnEvents.length} events)`);
    return {
      ok: false,
      skipped: 'empty_turn',
      rename: { attempted: false, renamed: false },
    };
  }

  const state = await loadSidebarState();
  const previousEntry = state.sessions[sessionId] || {};
  const prevBackground = previousEntry.background || '';
  const currentGroup = normalizeSessionGroup(group || previousEntry.group || '');
  const currentDescription = normalizeSessionDescription(description || previousEntry.description || '');
  const promptContext = await loadSessionLabelPromptContext({
    ...sessionMeta,
    group: currentGroup,
    description: currentDescription,
  }, turnText);

  const shouldGenerateTitle = isSessionAutoRenamePending({ name, autoRenamePending });
  const shouldGenerateGrouping = !currentGroup || !currentDescription;
  const prompt = [
    'You are updating a developer\'s session status board. Be extremely concise.',
    'Treat the display group as a flexible project-like container: usually the top-level project or recurring domain. The title should name the concrete subtask inside that group.',
    'Reuse an existing display group when the scope clearly matches. Create a new group only when the work clearly belongs to a different project or domain.',
    'The latest turn may be underspecified. Use earlier session context, scope-router hints, and existing session metadata to infer the right top-level project before naming.',
    '',
    `Session folder: ${folder}`,
    `Session name: ${name || '(unnamed)'}`,
    currentGroup ? `Current display group: ${currentGroup}` : '',
    currentDescription ? `Current session description: ${currentDescription}` : '',
    shouldGenerateTitle && name ? 'The current session name is only a temporary draft. Generate a better final title.' : '',
    shouldGenerateGrouping ? 'Generate a stable one-level display group for sidebar organization. This is not a filesystem path.' : '',
    shouldGenerateTitle ? 'The display group is shown separately in the UI. The title must focus on the specific task inside that group and should not repeat the group/domain words unless disambiguation truly requires it.' : '',
    prevBackground ? `Previous background: ${prevBackground}` : '',
    promptContext.contextSummary ? `Earlier session context:\n${promptContext.contextSummary}` : '',
    promptContext.scopeRouter ? `Known scope router entries:\n${promptContext.scopeRouter}` : '',
    promptContext.existingSessions ? `Current non-archived sessions:\n${promptContext.existingSessions}` : '',
    '',
    'Last turn:',
    turnText,
    '',
    'Write a JSON object with exactly these fields:',
    '- "background": One sentence — what is this session working on overall? Update if this turn changes the focus.',
    '- "lastAction": One sentence — the single most important thing that just happened.',
    shouldGenerateTitle ? '- "title": 2-5 words — a short descriptive title for this session (e.g. "Fix auth bug", "Add dark mode", "Refactor API layer"). No quotes around the title.' : '',
    shouldGenerateGrouping ? '- "group": 1-3 words — a stable display group for similar work (e.g. "RemoteLab", "Video tooling", "Hiring"). Not a path.' : '',
    shouldGenerateGrouping ? '- "description": One sentence — a compact hidden description of the work, useful for future regrouping.' : '',
    '',
    'Respond with ONLY valid JSON. No markdown, no explanation.',
  ].filter(l => l !== null && l !== '').join('\n');

  const modelText = await runToolJsonPrompt(sessionMeta, prompt);
  const summary = parseJsonObject(modelText);

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
      group: summary.group || currentGroup || '',
      description: summary.description || currentDescription || '',
      background: summary.background,
      lastAction: summary.lastAction,
      updatedAt: Date.now(),
    };
    await saveSidebarState(state);
    broadcastSidebarInvalidation();
    console.log(`[summarizer] Updated sidebar for session ${sessionId.slice(0, 8)}: ${summary.lastAction}`);
  }

  // Auto-rename session if it still has a pending temporary/default name and a title was generated
  let rename = { attempted: shouldGenerateTitle, renamed: false };
  if (onRename && summary.title && shouldGenerateTitle) {
    const finalGroup = normalizeSessionGroup(summary.group || currentGroup || '');
    const newName = normalizeGeneratedSessionTitle(summary.title, finalGroup);
    if (newName) {
      console.log(`[summarizer] Auto-renaming session ${sessionId.slice(0, 8)} to: ${newName}`);
      const renamed = await onRename(newName);
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

export async function getSidebarState() {
  return loadSidebarState();
}

export async function renameSidebarEntry(sessionId, name) {
  return updateSidebarEntry(sessionId, { name });
}

export async function updateSidebarEntry(sessionId, patch) {
  const state = await loadSidebarState();
  if (!state.sessions[sessionId]) return false;
  state.sessions[sessionId] = {
    ...state.sessions[sessionId],
    ...patch,
  };
  await saveSidebarState(state);
  broadcastSidebarInvalidation();
  return true;
}
