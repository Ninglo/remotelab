# Implementation Recipes

Step-by-step guides for the most common modifications. Each recipe gives exact file paths, function names, and the cross-file change sequence so you can start coding immediately.

These recipes complement `AGENTS.md` (constraints, priorities) and `docs/project-architecture.md` (architecture understanding). Read those first for context; use these when you need to **change** the system.

---

## Recipe 1: Add a New API Endpoint

**Example:** `POST /api/sessions/:id/rename` that takes `{ name, group }`.

### Step 1 — Choose the route file

| Route file | Handles |
|---|---|
| `chat/router-session-main-routes.mjs` | Session GET/POST: list, detail, events, messages, cancel, fork, share |
| `chat/router-control-routes.mjs` | PATCH/DELETE + non-session resources: runs, tools, apps, settings, push, browse |
| `chat/router-public-routes.mjs` | Unauthenticated: `/agent/:token`, `/share/:id`, `/login`, static files |

> **Gotcha:** `PATCH /api/sessions/:id` lives in `router-control-routes.mjs`, not `router-session-main-routes.mjs`. Session-main handles GET/POST on the session resource; control-routes handles PATCH/configuration.

### Step 2 — Add the route match

In `chat/router.mjs`, routes are dispatched by the `handleRequest()` function (line ~1172). It calls the sub-handlers in order:

```javascript
// router.mjs handleRequest() dispatches to:
// 1. handleSessionMainRoutes({...})  → returns boolean
// 2. handleControlRoutes({...})      → returns boolean
// 3. handlePublicRoutes({...})       → returns boolean
```

Each sub-handler checks `pathname` + `req.method` and returns `true` if it handled the request. Add your new route match inside the appropriate sub-handler file.

**Handler function signature** (same in all route files):
```javascript
export async function handleControlRoutes({
  req, res, parsedUrl, pathname, authSession,
  writeJson, writeJsonCached, requireSessionAccess, ...
}) {
  // Match your route:
  if (pathname.match(/^\/api\/sessions\/[^/]+\/rename$/) && req.method === 'POST') {
    const sessionId = pathname.split('/')[3];
    const access = await requireSessionAccess(sessionId, authSession);
    if (!access) return true; // Already sent 403/404

    // ... handle logic ...
    writeJson(res, 200, { ok: true });
    return true;
  }
  // ... existing routes ...
}
```

### Step 3 — Implement the business logic

Business logic lives in `chat/session-manager.mjs` (or its extracted helpers). Key functions:

```javascript
// session-manager.mjs exports:
import { updateSession } from './session-manager.mjs';

// updateSession(sessionId, patch) — updates metadata and persists
// Returns: updated session object
```

For naming specifically:
```javascript
import { applySessionRename } from './session-naming.mjs';
// applySessionRename(session, { name, group }) — normalizes and applies rename
```

### Step 4 — Notify connected clients

```javascript
import { broadcastOwners } from './ws-clients.mjs';

// After the mutation:
broadcastOwners({ type: 'session_invalidated', sessionId });

// For changes that affect the session list (new/delete/archive):
broadcastOwners({ type: 'sessions_invalidated' });
```

**WS message types:**
- `{ type: 'session_invalidated', sessionId }` — one session changed, frontend re-fetches that session
- `{ type: 'sessions_invalidated' }` — session list changed, frontend re-fetches the full list

### Step 5 — Frontend receives the update automatically

No frontend code needed for data refresh — the WS invalidation triggers `handleWsMessage()` in `static/chat/realtime.js` (line ~427), which calls `refreshCurrentSession()` or `refreshSidebarSession()` depending on which session was invalidated.

If you need new UI (a button that calls your endpoint):

```javascript
// static/chat/*.js — use the shared HTTP helper:
const result = await fetchJsonOrRedirect(`/api/sessions/${sessionId}/rename`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, group }),
});
```

---

## Recipe 2: Add a New Runtime Adapter

**Example:** Add a hypothetical `gemini` CLI tool that produces JSONL output.

### Step 1 — Register the tool

**File:** `lib/tools.mjs`

Add to the `BUILTIN_TOOLS` array (line ~25):

```javascript
const BUILTIN_TOOLS = [
  { id: 'codex', name: 'CodeX', command: 'codex', runtimeFamily: 'codex-json' },
  { id: 'claude', name: 'Claude Code', command: 'claude', runtimeFamily: 'claude-stream-json' },
  { id: 'gemini', name: 'Gemini', command: 'gemini', runtimeFamily: 'gemini-json' }, // ← NEW
];
```

The `runtimeFamily` string is the key dispatch mechanism — it determines which adapter is selected.

### Step 2 — Create the adapter

**File:** `chat/adapters/gemini.mjs` (new file)

```javascript
import { messageEvent, toolUseEvent, toolResultEvent, statusEvent, usageEvent } from '../normalizer.mjs';

export function createGeminiAdapter() {
  return {
    parseLine(line) {
      // line: one line of JSONL stdout from the CLI tool
      // Return: Event[] (array of normalized events)
      const trimmed = line.trim();
      if (!trimmed) return [];

      let obj;
      try { obj = JSON.parse(trimmed); } catch { return []; }

      const events = [];
      // Map the tool's JSONL types to normalized events:
      // Use messageEvent(role, content, images, extra) for assistant text
      // Use toolUseEvent(toolName, toolInput) for tool calls
      // Use toolResultEvent(toolName, output, exitCode) for tool results
      // Use statusEvent(content) for status updates
      // Use usageEvent({ inputTokens, outputTokens }) for token usage
      return events;
    },

    flush() {
      // Called on EOF — emit any final events
      return [];
    },
  };
}
```

**Normalized event factories** (from `chat/normalizer.mjs`):

| Factory | Parameters | Purpose |
|---|---|---|
| `messageEvent(role, content, images, extra)` | role: `'user'\|'assistant'`, content: string | Chat messages |
| `toolUseEvent(toolName, toolInput)` | toolName: string, toolInput: string/JSON | Tool invocations |
| `toolResultEvent(toolName, output, exitCode)` | toolName: string, output: string | Tool results |
| `reasoningEvent(content)` | content: string | Thinking/reasoning blocks |
| `statusEvent(content)` | content: string | Status updates (`'thinking'`, `'completed'`) |
| `usageEvent({ inputTokens, outputTokens, ... })` | object | Token usage tracking |
| `fileChangeEvent(filePath, changeType)` | filePath: string, changeType: string | File modifications |

All events auto-get `{ type, id, timestamp }` from the shared `createEvent()` base.

### Step 3 — Wire the adapter into process-runner

**File:** `chat/process-runner.mjs`

In `createToolInvocation()` (line ~38), add the adapter selection:

```javascript
import { createGeminiAdapter } from './adapters/gemini.mjs';

// Inside createToolInvocation():
// The function already has: const runtimeFamily = tool.runtimeFamily;
// Add a branch for your new family:

let adapter;
if (runtimeFamily === 'claude-stream-json') {
  adapter = createClaudeAdapter();
} else if (runtimeFamily === 'codex-json') {
  adapter = createCodexAdapter();
} else if (runtimeFamily === 'gemini-json') {  // ← NEW
  adapter = createGeminiAdapter();
}

return { command, adapter, args, envOverrides, runtimeFamily };
```

### Step 4 — Add model definitions

**File:** `chat/models.mjs`

In `getModelsForTool()` (line ~81), add a branch:

```javascript
if (toolId === 'gemini') {
  return {
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    effortLevels: null,
    defaultModel: 'gemini-2.5-pro',
    reasoning: { kind: 'none' },
  };
}
```

### Step 5 — Build CLI arguments

Back in `process-runner.mjs`, construct the CLI args for your tool:

```javascript
// Build args based on what your CLI expects:
const args = [];
if (model) args.push('--model', model);
args.push('--output-format', 'jsonl');  // Ensure JSONL output
// The prompt is typically passed via stdin or --prompt flag
```

**That's it.** The rest of the pipeline (spool writing, normalization, history persistence, frontend rendering) works automatically because it operates on normalized events.

---

## Recipe 3: Modify the Frontend Sidebar / Session List

**Example:** Add a "workflow state" grouping section to the sidebar.

### Step 1 — Understand the data flow

```
Backend                              Frontend
───────                              ────────
GET /api/sessions                    session-http.js → fetchSessionsList()
  → returns session objects            ↓
  with { group, workflowState,      session-store.js → dispatch({ type: 'replace-active-sessions', sessions })
         pinned, activity, ... }       ↓
                                     session-list-ui.js → renderSessionList()
                                       ↓
WS: { type: 'session_invalidated' } realtime.js → handleWsMessage()
  → triggers re-fetch                 → calls refreshSidebarSession(sessionId)
                                       → upserts into store → re-renders
```

### Step 2 — Check available session fields

The backend returns these fields per session (from `chat/session-api-shapes.mjs`):

```javascript
{
  id, name, tool, model, thinking, effort,
  archived, pinned, folder, group, description,
  sidebarOrder, visitorId, messageCount,
  activity: {
    run: { state: 'running'|'idle', phase?, requestId? },
    queue: { count: number }
  },
  workflowState,   // 'parked' | 'waiting_user' | 'done' | undefined
  workflowPriority,
  // ... other metadata
}
```

If you need a new field: add it in `session-api-shapes.mjs` → `stripSessionShape()`.

### Step 3 — Modify the grouping logic

**File:** `static/chat/session-list-ui.js`

The current `renderSessionList()` function groups sessions using `getSessionGroupInfo(session)`:

```javascript
// Current grouping pattern:
const groups = new Map();
for (const s of visibleSessions) {
  const groupInfo = getSessionGroupInfo(s);  // returns { key, label }
  if (!groups.has(groupInfo.key)) {
    groups.set(groupInfo.key, { ...groupInfo, sessions: [] });
  }
  groups.get(groupInfo.key).sessions.push(s);
}
```

To add workflow-state grouping, modify or wrap this logic:

```javascript
// Group by workflow state first, then by existing group:
const workflowGroups = new Map();
for (const s of visibleSessions) {
  const wfState = s.workflowState || 'active';
  if (!workflowGroups.has(wfState)) {
    workflowGroups.set(wfState, []);
  }
  workflowGroups.get(wfState).push(s);
}
```

### Step 4 — Render the new sections

Each group renders as a collapsible `<div class="folder-group">`:

```javascript
const group = document.createElement('div');
group.className = 'folder-group';

const header = document.createElement('div');
header.className = 'folder-group-header';
header.innerHTML = `<span>${esc(groupLabel)}</span>
                    <span class="folder-count">${sessions.length}</span>`;
header.addEventListener('click', () => {
  header.classList.toggle('collapsed');
  // Persist collapse state:
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsedState));
});

const items = document.createElement('div');
items.className = 'folder-group-items';
for (const s of sessions) {
  items.appendChild(createActiveSessionItem(s));
}

group.appendChild(header);
group.appendChild(items);
sessionList.appendChild(group);
```

### Step 5 — Sidebar layout

**File:** `static/chat/sidebar-ui.js` — controls sidebar open/close, width, and attachment picker. Modify this only if you need structural sidebar changes (new tabs, panels).

**File:** `static/chat/session-surface-ui.js` — controls the session header bar (title, actions). Modify if adding per-session action buttons.

### Step 6 — Use i18n for labels

**File:** `static/chat/i18n.js`

```javascript
// Add translation keys:
// In the strings object, add:
'sidebar.workflow_active': 'Active',
'sidebar.workflow_waiting': 'Waiting for you',
'sidebar.workflow_parked': 'Parked',

// Use in rendering:
import { t } from './i18n.js';
header.textContent = t('sidebar.workflow_active');
```

### Step 7 — No explicit refresh wiring needed

The WS invalidation → store update → re-render pipeline handles refresh automatically. When the backend sends `{ type: 'session_invalidated', sessionId }`, `realtime.js` triggers the re-fetch, the store updates, and `renderSessionList()` is called with the new state.

---

## Quick Reference: Key Function Signatures

These are the functions you'll call most often when extending RemoteLab.

### Backend

```javascript
// Session mutations (chat/session-manager.mjs)
updateSession(sessionId, patch)               // → updated session
deleteSession(sessionId)                      // → void

// Session naming (chat/session-naming.mjs)
applySessionRename(session, { name, group })  // → void (mutates session)

// WS broadcast (chat/ws-clients.mjs)
broadcastAll(msg)                             // → void, to all clients
broadcastOwners(msg)                          // → void, to owner clients only

// JSON response (passed into route handlers)
writeJson(res, statusCode, body)              // → void
writeJsonCached(req, res, body)               // → void, with ETag caching

// Tool resolution (lib/tools.mjs)
getAvailableToolsAsync()                      // → Tool[]
getToolDefinitionAsync(toolId)                // → Tool | null

// Adapter creation (chat/adapters/*.mjs)
createClaudeAdapter()                         // → { parseLine(line), flush() }
createCodexAdapter()                          // → { parseLine(line), flush() }

// Event factories (chat/normalizer.mjs)
messageEvent(role, content, images, extra)    // → { type: 'message', ... }
toolUseEvent(toolName, toolInput)             // → { type: 'tool_use', ... }
toolResultEvent(toolName, output, exitCode)   // → { type: 'tool_result', ... }
statusEvent(content)                          // → { type: 'status', ... }
usageEvent({ inputTokens, outputTokens })     // → { type: 'usage', ... }
```

### Frontend

```javascript
// Store (static/chat/session-store.js)
store.getState()                              // → { sessions, currentSessionId, ... }
store.dispatch({ type, ...payload })          // → void, notifies subscribers
store.subscribe(listener)                     // → unsubscribe function

// HTTP (static/chat/session-http-helpers.js)
fetchJsonOrRedirect(url, fetchOptions)        // → parsed JSON or redirect

// i18n (static/chat/i18n.js)
t(key)                                        // → translated string
esc(text)                                     // → HTML-escaped string
```
