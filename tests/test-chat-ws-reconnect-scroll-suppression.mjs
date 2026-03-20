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

const connectSource = extractFunctionSource(realtimeSource, 'connect');

const createdSockets = [];
const refreshCalls = [];
const statusCalls = [];

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    createdSockets.push(this);
  }

  close() {}
}

const context = {
  console,
  location: {
    protocol: 'https:',
    host: 'chat.example.test',
  },
  WebSocket: FakeWebSocket,
  resolveWsUrl(path) {
    return path;
  },
  updateStatus(state, session) {
    statusCalls.push({ state, session });
  },
  getCurrentSession() {
    return { id: 'session_current' };
  },
  refreshRealtimeViews(options = {}) {
    refreshCalls.push(options);
    return Promise.resolve();
  },
  scheduleReconnect() {},
  hasSeenWsOpen: false,
  ws: null,
};
context.globalThis = context;

vm.runInNewContext(`${connectSource}\nglobalThis.connect = connect;`, context, {
  filename: 'static/chat/realtime.js',
});

context.connect();
assert.equal(createdSockets.length, 1, 'connect should open the initial WebSocket');
assert.equal(createdSockets[0].url, 'wss://chat.example.test/ws', 'connect should resolve the chat WebSocket URL');
createdSockets[0].onopen();

assert.equal(context.hasSeenWsOpen, true, 'the first successful open should mark the socket as seen');
assert.equal(refreshCalls.length, 0, 'the first successful open should not trigger a recovery refresh');

context.connect();
assert.equal(createdSockets.length, 2, 'reconnect should create a fresh WebSocket');
createdSockets[1].onopen();

assert.equal(refreshCalls.length, 1, 'reconnect should trigger exactly one recovery refresh');
assert.equal(
  refreshCalls[0]?.viewportIntent,
  'preserve',
  'reconnect recovery should preserve the current reading position instead of acting like a new session entry',
);

assert.equal(statusCalls.length, 2, 'each open should refresh the visible connection status');

console.log('test-chat-ws-reconnect-scroll-suppression: ok');
