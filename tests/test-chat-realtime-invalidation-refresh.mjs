#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const realtimeSource = readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const handleWsMessageSource = extractFunctionSource(realtimeSource, 'handleWsMessage');

function createContext(overrides = {}) {
  const calls = {
    sessions: [],
    archived: [],
    current: [],
    sidebar: [],
    realtime: [],
  };
  const context = {
    console,
    archivedSessionsLoaded: false,
    currentSessionId: 'session-current',
    visitorMode: false,
    fetchSessionsList(options = {}) {
      calls.sessions.push(options);
      return Promise.resolve([]);
    },
    fetchArchivedSessions(options = {}) {
      calls.archived.push(options);
      return Promise.resolve([]);
    },
    refreshCurrentSession(options = {}) {
      calls.current.push(options);
      return Promise.resolve(null);
    },
    refreshSidebarSession(sessionId, options = {}) {
      calls.sidebar.push({ sessionId, options });
      return Promise.resolve(null);
    },
    refreshRealtimeViews(options = {}) {
      calls.realtime.push(options);
      return Promise.resolve(null);
    },
    showSystemToast() {},
    ...overrides,
  };
  context.globalThis = context;
  context.__calls = calls;
  return context;
}

function assertJsonEqual(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

{
  const context = createContext({ archivedSessionsLoaded: true });
  vm.runInNewContext(`${handleWsMessageSource}\nglobalThis.handleWsMessage = handleWsMessage;`, context, {
    filename: 'static/chat/realtime.js',
  });
  context.handleWsMessage({ type: 'sessions_invalidated' });
  await new Promise((resolve) => setImmediate(resolve));
  assertJsonEqual(
    context.__calls.sessions,
    [{ forceFresh: true }],
    'sessions_invalidated should force-fresh the owner session list',
  );
  assertJsonEqual(
    context.__calls.archived,
    [{ forceFresh: true }],
    'sessions_invalidated should force-fresh the archived list when it is open',
  );
}

{
  const context = createContext();
  vm.runInNewContext(`${handleWsMessageSource}\nglobalThis.handleWsMessage = handleWsMessage;`, context, {
    filename: 'static/chat/realtime.js',
  });
  context.handleWsMessage({ type: 'session_invalidated' });
  await new Promise((resolve) => setImmediate(resolve));
  assertJsonEqual(
    context.__calls.realtime,
    [{ forceFresh: true }],
    'session_invalidated without a session id should force a full fresh realtime refresh',
  );
}

{
  const context = createContext();
  vm.runInNewContext(`${handleWsMessageSource}\nglobalThis.handleWsMessage = handleWsMessage;`, context, {
    filename: 'static/chat/realtime.js',
  });
  context.handleWsMessage({ type: 'session_invalidated', sessionId: 'session-current' });
  await new Promise((resolve) => setImmediate(resolve));
  assertJsonEqual(
    context.__calls.current,
    [{ forceFresh: true }],
    'current-session invalidations should force-fresh the active session',
  );
}

{
  const context = createContext();
  vm.runInNewContext(`${handleWsMessageSource}\nglobalThis.handleWsMessage = handleWsMessage;`, context, {
    filename: 'static/chat/realtime.js',
  });
  context.handleWsMessage({ type: 'session_invalidated', sessionId: 'session-side' });
  await new Promise((resolve) => setImmediate(resolve));
  assertJsonEqual(
    context.__calls.sidebar,
    [{ sessionId: 'session-side', options: { forceFresh: true } }],
    'background session invalidations should force-fresh the sidebar snapshot',
  );
}

console.log('test-chat-realtime-invalidation-refresh: ok');
