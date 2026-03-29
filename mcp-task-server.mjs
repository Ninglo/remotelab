#!/usr/bin/env node
/**
 * RemoteLab MCP Task Server (task-only)
 *
 * Exposes ONLY task management tools — no session tools.
 * Intended for sub-workspace agents (ResearchCenter, skiplec, etc.)
 * that need to receive and report tasks without access to session management.
 *
 * Session MCP (mcp-server.mjs) is reserved for RLOrchestrator only.
 *
 * Usage:
 *   node mcp-task-server.mjs
 *
 * Environment variables:
 *   CHAT_PORT  — chat-server port (default: 7690)
 */

import { readFileSync } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';
import http from 'http';
import { TASK_TOOLS, executeTaskTool } from './mcp-task-tools.mjs';

const AUTH_FILE = join(homedir(), '.config', 'claude-web', 'auth.json');
const CHAT_PORT = parseInt(process.env.CHAT_PORT, 10) || 7690;
const BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;

// ---- Auth token ----

let authToken;
try {
  const auth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  authToken = auth.token;
} catch (err) {
  process.stderr.write(`[mcp-tasks] Failed to read auth token from ${AUTH_FILE}: ${err.message}\n`);
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
      process.stderr.write(`[mcp-tasks] handleMessage error: ${err.message}\n`);
    });
  } catch (err) {
    process.stderr.write(`[mcp-tasks] Failed to parse: ${err.message}\n`);
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

// ---- Task tools only (no launch_team, no session tools) ----

const EXPOSED_TOOLS = TASK_TOOLS.filter(t =>
  ['create_task', 'get_task', 'list_tasks', 'update_task'].includes(t.name)
);

// ---- Message handler ----

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'remotelab-tasks', version: '1.0.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') return;
  if (method === 'ping') { sendResult(id, {}); return; }

  if (method === 'tools/list') {
    sendResult(id, { tools: EXPOSED_TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (!EXPOSED_TOOLS.find(t => t.name === name)) {
      sendError(id, -32601, `Unknown tool: ${name}`);
      return;
    }
    try {
      const result = await executeTaskTool(name, args || {}, apiRequest);
      sendResult(id, result);
    } catch (err) {
      sendResult(id, {
        isError: true,
        content: [{ type: 'text', text: `Tool error: ${err.message}` }],
      });
    }
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}
