import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { CHAT_SESSIONS_FILE, CHAT_IMAGES_DIR } from '../lib/config.mjs';
import { spawnTool } from './process-runner.mjs';
import { loadHistory, appendEvent } from './history.mjs';
import { messageEvent, statusEvent } from './normalizer.mjs';
import { triggerSummary, removeSidebarEntry } from './summarizer.mjs';
import { sendCompletionPush } from './push.mjs';

const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

/**
 * Save base64 images to disk and return image metadata with file paths.
 */
function saveImages(images) {
  if (!images || images.length === 0) return [];
  if (!existsSync(CHAT_IMAGES_DIR)) mkdirSync(CHAT_IMAGES_DIR, { recursive: true });
  return images.map(img => {
    const ext = MIME_EXT[img.mimeType] || '.png';
    const filename = randomBytes(12).toString('hex') + ext;
    const filepath = join(CHAT_IMAGES_DIR, filename);
    writeFileSync(filepath, Buffer.from(img.data, 'base64'));
    return { filename, savedPath: filepath, mimeType: img.mimeType || 'image/png', data: img.data };
  });
}

// In-memory session registry
// sessionId -> { id, folder, tool, status, runner, listeners: Set<ws> }
const liveSessions = new Map();

function generateId() {
  return randomBytes(16).toString('hex');
}

// ---- Persistence ----

function loadSessionsMeta() {
  try {
    if (!existsSync(CHAT_SESSIONS_FILE)) return [];
    return JSON.parse(readFileSync(CHAT_SESSIONS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveSessionsMeta(list) {
  const dir = dirname(CHAT_SESSIONS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CHAT_SESSIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// ---- Public API ----

export function listSessions() {
  const metas = loadSessionsMeta();
  return metas.map(m => ({
    ...m,
    status: liveSessions.has(m.id)
      ? liveSessions.get(m.id).status
      : 'idle',
  }));
}

export function getSession(id) {
  const metas = loadSessionsMeta();
  const meta = metas.find(m => m.id === id);
  if (!meta) return null;
  const live = liveSessions.get(id);
  return {
    ...meta,
    status: live ? live.status : 'idle',
  };
}

export function createSession(folder, tool, name = 'new session') {
  const id = generateId();
  const session = {
    id,
    folder,
    tool,
    name: name || 'new session',
    created: new Date().toISOString(),
  };

  const metas = loadSessionsMeta();
  metas.push(session);
  saveSessionsMeta(metas);

  return { ...session, status: 'idle' };
}

export function deleteSession(id) {
  const live = liveSessions.get(id);
  if (live?.runner) {
    live.runner.cancel();
  }
  liveSessions.delete(id);

  const metas = loadSessionsMeta();
  const idx = metas.findIndex(m => m.id === id);
  if (idx === -1) return false;
  metas.splice(idx, 1);
  saveSessionsMeta(metas);
  removeSidebarEntry(id);
  return true;
}

export function renameSession(id, name) {
  const metas = loadSessionsMeta();
  const idx = metas.findIndex(m => m.id === id);
  if (idx === -1) return null;
  metas[idx].name = name;
  saveSessionsMeta(metas);
  const live = liveSessions.get(id);
  const updated = { ...metas[idx], status: live ? live.status : 'idle' };
  broadcast(id, { type: 'session', session: updated });
  return updated;
}

/**
 * Subscribe a WebSocket to session events.
 */
export function subscribe(sessionId, ws) {
  let live = liveSessions.get(sessionId);
  if (!live) {
    live = { status: 'idle', runner: null, listeners: new Set() };
    liveSessions.set(sessionId, live);
  }
  live.listeners.add(ws);
}

export function unsubscribe(sessionId, ws) {
  const live = liveSessions.get(sessionId);
  if (live) {
    live.listeners.delete(ws);
  }
}

/**
 * Broadcast event to all subscribed WebSocket clients.
 */
function broadcast(sessionId, msg) {
  const live = liveSessions.get(sessionId);
  if (!live) return;
  const data = JSON.stringify(msg);
  for (const ws of live.listeners) {
    try {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(data);
      }
    } catch {}
  }
}

/**
 * Send a user message to a session. Spawns a new process if needed.
 */
export function sendMessage(sessionId, text, images, options = {}) {
  const session = getSession(sessionId);
  if (!session) throw new Error('Session not found');

  // Determine effective tool: per-message override or session default
  const effectiveTool = options.tool || session.tool;
  console.log(`[session-mgr] sendMessage session=${sessionId.slice(0,8)} tool=${effectiveTool} (session.tool=${session.tool}) thinking=${!!options.thinking} text="${text.slice(0,80)}" images=${images?.length || 0}`);

  // Save images to disk
  const savedImages = saveImages(images);
  // For history/display: store filenames (not base64) so history files stay small
  const imageRefs = savedImages.map(img => ({ filename: img.filename, mimeType: img.mimeType }));

  // Store user message in history
  const userEvt = messageEvent('user', text, imageRefs.length > 0 ? imageRefs : undefined);
  appendEvent(sessionId, userEvt);
  broadcast(sessionId, { type: 'event', event: userEvt });

  let live = liveSessions.get(sessionId);
  if (!live) {
    live = { status: 'idle', runner: null, listeners: new Set() };
    liveSessions.set(sessionId, live);
  }

  console.log(`[session-mgr] live state: status=${live.status}, hasRunner=${!!live.runner}, claudeSessionId=${live.claudeSessionId || 'none'}, codexThreadId=${live.codexThreadId || 'none'}, listeners=${live.listeners.size}`);

  // If tool was switched, clear resume IDs (they are tool-specific)
  if (effectiveTool !== session.tool) {
    console.log(`[session-mgr] Tool switched from ${session.tool} to ${effectiveTool}, clearing resume IDs`);
    live.claudeSessionId = undefined;
    live.codexThreadId = undefined;
  }

  // If a process is still running, cancel it (all modes are oneshot now)
  if (live.runner) {
    console.log(`[session-mgr] Cancelling existing runner`);
    // Capture session/thread IDs before killing
    if (live.runner.claudeSessionId) {
      live.claudeSessionId = live.runner.claudeSessionId;
    }
    if (live.runner.codexThreadId) {
      live.codexThreadId = live.runner.codexThreadId;
    }
    live.runner.cancel();
    live.runner = null;
  }

  live.status = 'running';
  broadcast(sessionId, { type: 'session', session: { ...session, status: 'running' } });

  const onEvent = (evt) => {
    console.log(`[session-mgr] onEvent session=${sessionId.slice(0,8)} type=${evt.type} content=${(evt.content || evt.toolName || '').slice(0, 80)}`);
    appendEvent(sessionId, evt);
    broadcast(sessionId, { type: 'event', event: evt });
  };

  const onExit = (code) => {
    console.log(`[session-mgr] onExit session=${sessionId.slice(0,8)} code=${code}`);
    const l = liveSessions.get(sessionId);
    if (l) {
      // Capture session/thread IDs for next resume
      if (l.runner?.claudeSessionId) {
        l.claudeSessionId = l.runner.claudeSessionId;
        console.log(`[session-mgr] Saved claudeSessionId=${l.claudeSessionId} for session ${sessionId.slice(0,8)}`);
      }
      if (l.runner?.codexThreadId) {
        l.codexThreadId = l.runner.codexThreadId;
        console.log(`[session-mgr] Saved codexThreadId=${l.codexThreadId} for session ${sessionId.slice(0,8)}`);
      }
      l.status = 'idle';
      l.runner = null;
    }
    broadcast(sessionId, {
      type: 'session',
      session: { ...session, status: 'idle' },
    });

    // Handle compact completion: extract summary, reset session
    if (l?.pendingCompact) {
      l.pendingCompact = false;
      const h = loadHistory(sessionId);
      const lastAssistant = [...h].reverse().find(e => e.type === 'message' && e.role === 'assistant');
      if (lastAssistant?.content) {
        const match = lastAssistant.content.match(/<summary>([\s\S]*?)<\/summary>/i);
        const summary = match ? match[1].trim() : lastAssistant.content;
        l.claudeSessionId = undefined;
        l.codexThreadId = undefined;
        l.compactContext = `[Conversation summary]\n\n${summary}`;
      }
      const compactEvt = statusEvent('Context compacted — next message will resume from summary');
      appendEvent(sessionId, compactEvt);
      broadcast(sessionId, { type: 'event', event: compactEvt });
      return; // skip triggerSummary and push for compact ops
    }

    // Trigger async sidebar summary (non-blocking)
    triggerSummary(
      { id: sessionId, folder: session.folder, name: session.name || '' },
      (newName) => renameSession(sessionId, newName),
    );
    // Send web push notification (non-blocking)
    sendCompletionPush({ ...session, id: sessionId }).catch(() => {});
  };

  const spawnOptions = {};
  if (live.claudeSessionId) {
    spawnOptions.claudeSessionId = live.claudeSessionId;
    console.log(`[session-mgr] Will resume Claude session: ${live.claudeSessionId}`);
  }
  if (live.codexThreadId) {
    spawnOptions.codexThreadId = live.codexThreadId;
    console.log(`[session-mgr] Will resume Codex thread: ${live.codexThreadId}`);
  }

  if (savedImages.length > 0) {
    spawnOptions.images = savedImages;
  }
  if (options.thinking) {
    spawnOptions.thinking = true;
  }

  // If a compact/drop-tools context exists, inject it as preamble in the first new message
  let actualText = text;
  if (live.compactContext) {
    actualText = `${live.compactContext}\n\n---\n\n${text}`;
    live.compactContext = undefined;
  }

  console.log(`[session-mgr] Spawning tool=${effectiveTool} folder=${session.folder} thinking=${!!options.thinking}`);
  const runner = spawnTool(effectiveTool, session.folder, actualText, onEvent, onExit, spawnOptions);
  live.runner = runner;
}

/**
 * Cancel the running process for a session.
 */
export function cancelSession(sessionId) {
  const live = liveSessions.get(sessionId);
  if (live?.runner) {
    live.runner.cancel();
    live.runner = null;
    live.status = 'idle';
    const session = getSession(sessionId);
    broadcast(sessionId, {
      type: 'session',
      session: { ...session, status: 'idle' },
    });
    const evt = statusEvent('cancelled');
    appendEvent(sessionId, evt);
    broadcast(sessionId, { type: 'event', event: evt });
  }
}

/**
 * Get session history for replay on reconnect.
 */
export function getHistory(sessionId) {
  return loadHistory(sessionId);
}

/**
 * Drop tool use: strip all tool_use/tool_result/file_change events from context.
 * Resets the Claude session and injects a text-only transcript on the next message.
 * No model call is made — instant, local operation.
 */
export function dropToolUse(sessionId) {
  const session = getSession(sessionId);
  if (!session) return false;

  const history = loadHistory(sessionId);
  const textEvents = history.filter(e => e.type === 'message');

  const transcript = textEvents
    .map(e => `[${e.role === 'user' ? 'User' : 'Assistant'}]: ${e.content || ''}`)
    .join('\n\n');

  let live = liveSessions.get(sessionId);
  if (!live) {
    live = { status: 'idle', runner: null, listeners: new Set() };
    liveSessions.set(sessionId, live);
  }

  live.claudeSessionId = undefined;
  live.codexThreadId = undefined;

  if (transcript.trim()) {
    live.compactContext = `[Previous conversation — tool results removed]\n\n${transcript}`;
  }

  const kept = textEvents.length;
  const dropped = history.filter(e => ['tool_use','tool_result','file_change'].includes(e.type)).length;
  const evt = statusEvent(`Tool results dropped — ${dropped} tool events removed from context, ${kept} messages kept`);
  appendEvent(sessionId, evt);
  broadcast(sessionId, { type: 'event', event: evt });

  return true;
}

const COMPACT_PROMPT = `Please write a concise summary of our conversation to preserve context for continuation. Include: main task/goal, key decisions made, current state of work, and any important next steps. Wrap your summary in <summary></summary> tags.`;

/**
 * Compact: sends a summarization request to the model.
 * After the model responds, the session is reset and the summary becomes
 * the context preamble for the next user message.
 */
export function compactSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) return false;

  let live = liveSessions.get(sessionId);
  if (live?.status === 'running') return false;

  if (!live) {
    live = { status: 'idle', runner: null, listeners: new Set() };
    liveSessions.set(sessionId, live);
  }

  live.pendingCompact = true;
  sendMessage(sessionId, COMPACT_PROMPT, [], {});
  return true;
}

/**
 * Kill all running processes (for shutdown).
 */
export function killAll() {
  for (const [, live] of liveSessions) {
    if (live.runner) {
      live.runner.cancel();
    }
  }
  liveSessions.clear();
}
