#!/usr/bin/env node
/**
 * RemoteLab MCP Server
 *
 * Exposes RemoteLab session management as MCP tools over stdio transport.
 * Communicates with the chat-server via HTTP API on localhost.
 *
 * Usage:
 *   node mcp-server.mjs
 *
 * Environment variables:
 *   CHAT_PORT  — chat-server port (default: 7690)
 *
 * The server reads the auth token from ~/.config/claude-web/auth.json automatically.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import http from 'http';
import { TASK_TOOLS, executeTaskTool } from './mcp-task-tools.mjs';

const AUTH_FILE = join(homedir(), '.config', 'claude-web', 'auth.json');
const CHAT_PORT = parseInt(process.env.CHAT_PORT, 10) || 7690;
const BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
const MY_SESSION_ID = process.env.REMOTELAB_SESSION_ID || null;
const WORKFLOWS_DIR = join(import.meta.dirname, 'workflows');
const SCHEDULES_FILE = join(WORKFLOWS_DIR, 'schedules.json');

// ---- Auth token ----

let authToken;
try {
  const auth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  authToken = auth.token;
} catch (err) {
  process.stderr.write(`[mcp] Failed to read auth token from ${AUTH_FILE}: ${err.message}\n`);
  process.exit(1);
}

// ---- HTTP client ----

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---- MCP stdio transport (newline-delimited JSON-RPC 2.0) ----

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    handleMessage(msg).catch(err => {
      process.stderr.write(`[mcp] handleMessage error: ${err.message}\n`);
    });
  } catch (err) {
    process.stderr.write(`[mcp] Failed to parse: ${err.message}\n`);
  }
});

rl.on('close', () => {
  process.exit(0);
});

function sendResponse(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  sendResponse({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Send an MCP logging notification (server → client).
 * Used to report async session completion.
 */
function sendNotification(level, data) {
  sendResponse({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level, logger: 'remotelab', data },
  });
}

// ---- Background session watchers ----

// sessionId → { eventCountBefore, sessionName }
const activeWatchers = new Map();

async function watchSession(sessionId, eventCountBefore, sessionName, reportToSessionId = null) {
  if (activeWatchers.has(sessionId)) return; // already watching
  activeWatchers.set(sessionId, { eventCountBefore, sessionName });

  const maxWait = 30 * 60 * 1000; // 30 minutes
  const pollInterval = 3000;
  const startTime = Date.now();

  try {
    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));
      if (!activeWatchers.has(sessionId)) return; // was cancelled

      const statusRes = await apiRequest('GET', `/api/sessions/${sessionId}`);
      if (statusRes.status !== 200) {
        process.stderr.write(`[mcp] Session ${sessionId.slice(0,8)} status check failed: ${statusRes.status}\n`);
        continue;
      }
      if (statusRes.data.session?.status !== 'idle') continue;

      // Session finished — build compact notification
      const label = sessionName || sessionId.slice(0, 8);
      const firstMsg = await getOriginalFirstMessage(sessionId);
      const lastMsg = await getLastAssistantMessage(sessionId);

      const parts = [`[Session "${label}" completed]`];
      if (firstMsg) parts.push(`[Task] ${firstMsg}`);
      if (lastMsg) parts.push(`[Result] ${lastMsg}`);

      sendNotification('info', parts.join('\n'));

      if (reportToSessionId) {
        const reportText = `[子任务完成汇报]\n${parts.join('\n')}`;
        try {
          await apiRequest('POST', `/api/sessions/${reportToSessionId}/messages`, { text: reportText });
        } catch (err) {
          sendNotification('error', `[report_to failed] ${err.message}`);
        }
      }

      break;
    }
  } catch (err) {
    sendNotification('error', `[Session watcher error] ${sessionId.slice(0, 8)}: ${err.message}`);
  } finally {
    activeWatchers.delete(sessionId);
  }
}

/**
 * Trace back through compact chain to find the original first user message.
 */
async function getOriginalFirstMessage(sessionId) {
  let currentId = sessionId;
  const visited = new Set();

  // Follow continuedFrom chain to the root session
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const sessRes = await apiRequest('GET', `/api/sessions/${currentId}`);
    if (sessRes.status !== 200) break;
    const prev = sessRes.data.session?.continuedFrom;
    if (!prev) break;
    currentId = prev;
  }

  // Get the first user message from the root session
  const histRes = await apiRequest('GET', `/api/sessions/${currentId}/history`);
  if (histRes.status !== 200) return null;
  const events = histRes.data.events || [];
  const first = events.find(e => e.type === 'message' && e.role === 'user');
  return first?.content || null;
}

/**
 * Get the last assistant message from a session's history.
 */
async function getLastAssistantMessage(sessionId) {
  const histRes = await apiRequest('GET', `/api/sessions/${sessionId}/history`);
  if (histRes.status !== 200) return null;
  const events = histRes.data.events || [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'message' && events[i].role === 'assistant') {
      return events[i].content;
    }
  }
  return null;
}

// ---- MCP Tool definitions ----

const TOOLS = [
  {
    name: 'list_folders',
    description: 'List all project folders that have RemoteLab sessions, with session counts and session details for each folder.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_sessions',
    description: 'List all sessions, optionally filtered by folder path.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Filter by folder path (exact match). If omitted, returns all sessions.' },
      },
      required: [],
    },
  },
  {
    name: 'get_session',
    description: 'Get details of a specific session including its id, folder, tool, name, status, and creation time.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID (hex string).' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_session_history',
    description: 'Get the full message/event history of a session. Events include user messages, assistant messages, tool uses, tool results, file changes, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'create_session',
    description: 'Create a new session in a project folder with a specific CLI tool (e.g. "claude", "codex").',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Project folder path. Supports ~ for home directory.' },
        tool: { type: 'string', description: 'CLI tool to use (e.g. "claude", "codex").' },
        name: { type: 'string', description: 'Session name/label for easy identification.' },
      },
      required: ['folder', 'tool'],
    },
  },
  {
    name: 'delete_session',
    description: 'Delete a session. If the session has a running process, it will be cancelled first.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID to delete.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to an AI session (fire-and-forget). The message is dispatched to the CLI tool and this returns immediately. When the session finishes, a notification is automatically sent back with the results. Set wait=true to block until the response is ready instead. Optionally set report_to to automatically send results back to another session when done.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID to send the message to.' },
        text: { type: 'string', description: 'The message text to send.' },
        wait: { type: 'boolean', description: 'If true, block until session finishes and return results directly. Default: false (async with notification).' },
        tool: { type: 'string', description: 'Override the CLI tool for this message (e.g. "claude", "codex").' },
        thinking: { type: 'boolean', description: 'Enable extended thinking mode.' },
        model: { type: 'string', description: 'Override the model to use.' },
        report_to: { type: 'string', description: 'Session ID to report back to when this session completes. The result will be sent as a chat message to that session, waking it up if idle or interrupting if busy.' },
      },
      required: ['session_id', 'text'],
    },
  },
  {
    name: 'list_tools',
    description: 'List available CLI tools that can be used when creating sessions (e.g. claude, codex).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_label',
    description: 'Set a custom label/status on a session (e.g. "planned", "pending-review", "done"). If session_id is omitted, sets the label on the current session (self). Set label to null or omit it to clear.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID to label. If omitted, labels the current session (self).' },
        label: { type: 'string', description: 'Label ID to set (e.g. "planned", "pending-review", "done"). Omit or set to null to clear the label.' },
      },
      required: [],
    },
  },
  {
    name: 'list_labels',
    description: 'List all available session labels with their names and colors.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'restart_server',
    description: 'Restart all RemoteLab services. Two modes: "immediate" (kills all sessions, restarts now — only allowed for RLOrchestrator and remotelab sessions) and "wait" (monitors all sessions, auto-restarts when all are idle — available to all sessions). Default mode is "wait".',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID that triggered the restart. If omitted, uses the current session (self).' },
        mode: { type: 'string', enum: ['immediate', 'wait'], description: 'Restart mode: "immediate" forces restart now (restricted), "wait" waits for all sessions to be idle (default).', default: 'wait' },
      },
      required: [],
    },
  },
  {
    name: 'submit_report',
    description: 'Submit a report (HTML file) to the Report notification system. The HTML file will be validated (structure, content length, tag balance) before acceptance — if validation fails, detailed errors are returned so you can fix and retry. Only available to authorized workspaces (RLOrchestrator, DailyNews).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Report title (e.g., "惠远早报 — 2026-03-18")' },
        file_path: { type: 'string', description: 'Absolute path to the HTML file to submit' },
        session_id: { type: 'string', description: 'Session ID of the submitting agent (for permission check and linking)' },
        source: { type: 'string', description: 'Source agent name (e.g., "DailyNews", "RLOrchestrator")' },
      },
      required: ['title', 'file_path', 'session_id', 'source'],
    },
  },
  {
    name: 'schedule_message',
    description: 'Schedule a message to be sent to a session. Supports one-shot (delay_ms or run_at) and recurring (interval_ms) modes. For one-shot: provide delay_ms or run_at (not both). For recurring: provide interval_ms (fires repeatedly at this interval).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session ID to send the message to.' },
        text: { type: 'string', description: 'The message text to send.' },
        delay_ms: { type: 'number', description: 'Delay in milliseconds before sending. Mutually exclusive with run_at.' },
        run_at: { type: 'string', description: 'ISO 8601 timestamp for when to send. Mutually exclusive with delay_ms.' },
        interval_ms: { type: 'number', description: 'Interval in milliseconds for recurring delivery. Mutually exclusive with delay_ms and run_at.' },
      },
      required: ['session_id', 'text'],
    },
  },
  ...TASK_TOOLS,
];

// ---- Tool execution ----

async function executeTool(name, args) {
  switch (name) {
    case 'list_folders': {
      const res = await apiRequest('GET', '/api/folders');
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'list_sessions': {
      const path = args.folder ? `/api/sessions?folder=${encodeURIComponent(args.folder)}` : '/api/sessions';
      const res = await apiRequest('GET', path);
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'get_session': {
      const res = await apiRequest('GET', `/api/sessions/${args.session_id}`);
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'get_session_history': {
      const res = await apiRequest('GET', `/api/sessions/${args.session_id}/history`);
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'create_session': {
      const body = { folder: args.folder, tool: args.tool };
      if (args.name) body.name = args.name;
      const res = await apiRequest('POST', '/api/sessions', body);
      if (res.status !== 201) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'delete_session': {
      const res = await apiRequest('DELETE', `/api/sessions/${args.session_id}`);
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'send_message': {
      const wait = args.wait === true; // default false (async)

      // Snapshot current event count before sending
      let eventCountBefore = 0;
      const histRes = await apiRequest('GET', `/api/sessions/${args.session_id}/history`);
      if (histRes.status === 200 && histRes.data.events) {
        eventCountBefore = histRes.data.events.length;
      }

      // Get session name for notification label
      let sessionName = '';
      const sessRes = await apiRequest('GET', `/api/sessions/${args.session_id}`);
      if (sessRes.status === 200) {
        sessionName = sessRes.data.session?.name || '';
      }

      // Context injection: warn about other active sessions in the same folder
      let messageText = args.text;
      try {
        const folder = sessRes.status === 200 ? sessRes.data.session?.folder : null;
        if (folder) {
          const allRes = await apiRequest('GET', `/api/sessions?folder=${encodeURIComponent(folder)}`);
          if (allRes.status === 200 && allRes.data.sessions) {
            const otherActive = allRes.data.sessions.filter(
              s => s.id !== args.session_id && s.status === 'running'
            );
            if (otherActive.length > 0) {
              const names = otherActive.map(s => s.name || s.id.slice(0, 8));
              messageText = `\u26a0\ufe0f 同仓库其他活跃 session: [${names.join(', ')}]\n请注意协调，避免修改冲突。\n---\n${messageText}`;
            }
          }
        }
      } catch (err) {
        process.stderr.write(`[mcp] Context injection failed: ${err.message}\n`);
      }

      // Send the message (include report_to so chat-server handles the callback server-side)
      const body = { text: messageText };
      if (args.tool) body.tool = args.tool;
      if (args.thinking) body.thinking = true;
      if (args.model) body.model = args.model;
      const effectiveReportTo = (!args.report_to || args.report_to === 'current') ? MY_SESSION_ID : args.report_to;
      if (effectiveReportTo) body.report_to = effectiveReportTo;

      const res = await apiRequest('POST', `/api/sessions/${args.session_id}/messages`, body);
      if (res.status !== 202) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };

      if (!wait) {
        // Async: start background watcher, return immediately
        watchSession(args.session_id, eventCountBefore, sessionName, effectiveReportTo);
        return { content: [{ type: 'text', text: `Message dispatched to session "${sessionName || args.session_id.slice(0, 8)}". You will receive a notification when it completes.` }] };
      }

      // Sync: poll until session goes idle (max 10 minutes)
      const maxWait = 10 * 60 * 1000;
      const pollInterval = 2000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        await new Promise(r => setTimeout(r, pollInterval));
        const statusRes = await apiRequest('GET', `/api/sessions/${args.session_id}`);
        if (statusRes.status !== 200) continue;
        if (statusRes.data.session?.status === 'idle') break;
      }

      // Fetch new events
      const finalHist = await apiRequest('GET', `/api/sessions/${args.session_id}/history`);
      if (finalHist.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${finalHist.status}: ${JSON.stringify(finalHist.data)}` }] };

      const newEvents = finalHist.data.events.slice(eventCountBefore);
      const summary = formatEvents(newEvents);
      return { content: [{ type: 'text', text: summary }] };
    }

    case 'list_tools': {
      const res = await apiRequest('GET', '/api/tools');
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'set_label': {
      const targetId = args.session_id || MY_SESSION_ID;
      if (!targetId) return { isError: true, content: [{ type: 'text', text: 'No session_id provided and no current session ID available (REMOTELAB_SESSION_ID not set).' }] };
      const res = await apiRequest('PATCH', `/api/sessions/${targetId}/label`, { label: args.label || null });
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'list_labels': {
      const res = await apiRequest('GET', '/api/session-labels');
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'restart_server': {
      const triggerId = args.session_id || MY_SESSION_ID;
      const mode = args.mode || 'wait';
      const XDG = `XDG_RUNTIME_DIR=/run/user/${process.getuid()}`;
      const log = [];

      // Permission check: only RLOrchestrator and remotelab sessions can use "immediate"
      if (mode === 'immediate') {
        const ALLOWED_FOLDERS = ['RLOrchestrator', 'huiyuanclaw/remotelab'];
        let allowed = false;
        if (triggerId) {
          try {
            const sessRes = await apiRequest('GET', `/api/sessions/${triggerId}`);
            if (sessRes.status === 200) {
              const folder = sessRes.data.session?.folder || '';
              allowed = ALLOWED_FOLDERS.some(f => folder.includes(f));
            }
          } catch {}
        }
        if (!allowed) {
          return { isError: true, content: [{ type: 'text', text: 'Permission denied: only RLOrchestrator and remotelab sessions can use immediate restart. Use mode="wait" instead.' }] };
        }
      }

      // "wait" mode: ask chat-server to monitor and restart when all idle
      if (mode === 'wait') {
        try {
          const res = await apiRequest('POST', '/api/restart', { session_id: triggerId, mode: 'wait' });
          if (res.status === 200) {
            if (res.data.immediate) {
              log.push('✓ All sessions were already idle — server restarting immediately');
            } else if (res.data.alreadyPending) {
              log.push('⚠ A restart is already pending (requested at ' + new Date(res.data.requestedAt).toISOString() + ')');
            } else {
              log.push('✓ Pending restart registered — server will restart when all sessions are idle');
              log.push('  UI will show a "waiting for restart" banner with a manual restart button');
            }
          } else {
            log.push(`✗ Failed to register pending restart: ${JSON.stringify(res.data)}`);
          }
        } catch (e) {
          log.push(`✗ Error: ${e.message}`);
        }
        return { content: [{ type: 'text', text: log.join('\n') }] };
      }

      // "immediate" mode: original behavior
      // Step 1: Label the triggering session (while chat-server is still alive)
      if (triggerId) {
        try {
          await apiRequest('PATCH', `/api/sessions/${triggerId}/label`, { label: 'asked-for-restart' });
          log.push(`✓ Labeled session ${triggerId.slice(0, 8)} as "asked-for-restart"`);
        } catch (e) {
          log.push(`⚠ Could not label session: ${e.message}`);
        }
      }

      // Step 2: daemon-reload + restart chat & proxy
      try {
        execSync(`${XDG} systemctl --user daemon-reload`, { timeout: 10000 });
        log.push('✓ daemon-reload complete');
      } catch (e) {
        log.push(`⚠ daemon-reload failed: ${e.message}`);
      }

      try {
        execSync(`${XDG} systemctl --user restart remotelab-chat.service remotelab-proxy.service`, { timeout: 30000 });
        log.push('✓ Restarted remotelab-chat + remotelab-proxy');
      } catch (e) {
        log.push(`⚠ Restart failed: ${e.message}`);
      }

      // Step 3: Wait for chat-server to come back (poll up to 30s)
      let serverUp = false;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const health = await apiRequest('GET', '/api/session-labels');
          if (health.status === 200) { serverUp = true; break; }
        } catch {}
      }
      log.push(serverUp ? '✓ Chat-server is back online' : '✗ Chat-server did not recover within 30s');

      // Step 4: Check tunnel, start if needed
      try {
        const tunnelStatus = execSync(`${XDG} systemctl --user is-active remotelab-tunnel.service`, { timeout: 5000 }).toString().trim();
        if (tunnelStatus === 'active') {
          log.push('✓ Cloudflare tunnel is active');
        } else {
          execSync(`${XDG} systemctl --user start remotelab-tunnel.service`, { timeout: 10000 });
          log.push('✓ Cloudflare tunnel was down, restarted');
        }
      } catch {
        try {
          execSync(`${XDG} systemctl --user start remotelab-tunnel.service`, { timeout: 10000 });
          log.push('✓ Cloudflare tunnel was down, restarted');
        } catch (e2) {
          log.push(`⚠ Cloudflare tunnel failed to start: ${e2.message}`);
        }
      }

      // Step 5: Final status
      try {
        const status = execSync(`${XDG} systemctl --user is-active remotelab-chat.service remotelab-proxy.service remotelab-tunnel.service`, { timeout: 5000 }).toString().trim();
        const lines = status.split('\n');
        log.push(`\nService status:\n  chat:   ${lines[0] || '?'}\n  proxy:  ${lines[1] || '?'}\n  tunnel: ${lines[2] || '?'}`);
      } catch {}

      return { content: [{ type: 'text', text: log.join('\n') }] };
    }

    case 'submit_report': {
      const res = await apiRequest('POST', '/api/internal/report', {
        title: args.title,
        file_path: args.file_path,
        session_id: args.session_id || MY_SESSION_ID,
        source: args.source,
      });
      if (res.status === 201) {
        return { content: [{ type: 'text', text: `Report submitted successfully.\nReport ID: ${res.data.reportId}\nTitle: ${args.title}` }] };
      }
      return { isError: true, content: [{ type: 'text', text: `Report submission failed (${res.status}): ${res.data?.error || JSON.stringify(res.data)}` }] };
    }

    case 'schedule_message': {
      const modes = [args.delay_ms, args.run_at, args.interval_ms].filter(Boolean).length;
      if (modes === 0) {
        return { isError: true, content: [{ type: 'text', text: 'Provide one of: delay_ms, run_at, or interval_ms.' }] };
      }
      if (modes > 1) {
        return { isError: true, content: [{ type: 'text', text: 'Provide only one of: delay_ms, run_at, or interval_ms.' }] };
      }

      let newSchedule;
      const scheduleId = `msg-${Date.now()}-${randomBytes(2).toString('hex')}`;
      const inlineWorkflow = {
        name: 'schedule_message',
        steps: [{
          id: 'send',
          type: 'sequential',
          tasks: [{
            id: 'msg',
            type: 'sessionMessage',
            sessionId: args.session_id,
            text: args.text,
          }],
        }],
      };

      if (args.interval_ms) {
        // Recurring interval schedule
        newSchedule = {
          id: scheduleId,
          cron: null,
          runAt: null,
          intervalMs: args.interval_ms,
          workflow: null,
          inlineWorkflow,
          enabled: true,
          disposable: false,
          maxRuns: null,
          runCount: 0,
          lastRun: null,
        };
      } else {
        // One-shot schedule
        const runAt = args.run_at
          ? new Date(args.run_at).toISOString()
          : new Date(Date.now() + args.delay_ms).toISOString();
        newSchedule = {
          id: scheduleId,
          cron: null,
          runAt,
          workflow: null,
          inlineWorkflow,
          enabled: true,
          disposable: true,
          maxRuns: 1,
          runCount: 0,
          lastRun: null,
        };
      }

      // Append to schedules.json
      let data;
      try {
        data = JSON.parse(readFileSync(SCHEDULES_FILE, 'utf8'));
      } catch (err) {
        process.stderr.write(`[mcp] Failed to parse schedules.json: ${err.message}\n`);
        data = { schedules: [] };
      }
      data.schedules.push(newSchedule);
      const tmp = SCHEDULES_FILE + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, SCHEDULES_FILE);

      process.stderr.write(`[mcp] schedule_message registered: id=${scheduleId} ${args.interval_ms ? `intervalMs=${args.interval_ms}` : `runAt=${newSchedule.runAt}`} target=${args.session_id.slice(0,8)}\n`);

      // Tell the scheduler to pick it up
      try {
        await apiRequest('POST', `/api/schedules/${scheduleId}/reload`);
      } catch {
        // Scheduler will pick it up on next restart if reload fails
      }

      const result = args.interval_ms
        ? { scheduleId, intervalMs: args.interval_ms, recurring: true }
        : { scheduleId, runAt: newSchedule.runAt };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'create_task':
    case 'get_task':
    case 'list_tasks':
    case 'update_task':
    case 'launch_team':
      return await executeTaskTool(name, args, apiRequest);

    default:
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
}

/**
 * Format events into a readable summary for the MCP client.
 */
function formatEvents(events) {
  if (!events || events.length === 0) return '(no new events)';

  const parts = [];
  for (const evt of events) {
    switch (evt.type) {
      case 'message':
        parts.push(`[${evt.role}] ${evt.content}`);
        break;
      case 'toolUse':
        parts.push(`[tool_use: ${evt.toolName}] ${(evt.content || '').slice(0, 500)}`);
        break;
      case 'toolResult':
        parts.push(`[tool_result: ${evt.toolName}] ${(evt.content || '').slice(0, 1000)}`);
        break;
      case 'fileChange':
        parts.push(`[file_change: ${evt.filePath}] ${evt.changeType || ''}`);
        break;
      case 'status':
        parts.push(`[status] ${evt.content}`);
        break;
      case 'usage':
        parts.push(`[usage] input=${evt.inputTokens || 0} output=${evt.outputTokens || 0} cache_read=${evt.cacheReadTokens || 0}`);
        break;
      default:
        parts.push(`[${evt.type}] ${evt.content || JSON.stringify(evt).slice(0, 200)}`);
    }
  }
  return parts.join('\n');
}

// ---- MCP message handler ----

async function handleMessage(msg) {
  // Notifications (no id) — just acknowledge
  if (msg.id === undefined || msg.id === null) {
    return;
  }

  switch (msg.method) {
    case 'initialize': {
      sendResult(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          logging: {},
        },
        serverInfo: {
          name: 'remotelab',
          version: '1.0.0',
        },
      });
      break;
    }

    case 'tools/list': {
      sendResult(msg.id, { tools: TOOLS });
      break;
    }

    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      try {
        const result = await executeTool(name, args || {});
        sendResult(msg.id, result);
      } catch (err) {
        process.stderr.write(`[mcp] tool error: ${err.message}\n`);
        sendResult(msg.id, {
          isError: true,
          content: [{ type: 'text', text: `Tool execution failed: ${err.message}` }],
        });
      }
      break;
    }

    case 'ping': {
      sendResult(msg.id, {});
      break;
    }

    default: {
      sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }
}

process.stderr.write(`[mcp] RemoteLab MCP server started (chat-server: ${BASE_URL})\n`);
