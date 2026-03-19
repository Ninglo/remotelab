#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const loaderSource = readFileSync(join(repoRoot, 'static/chat.js'), 'utf8');

function createScriptElement() {
  return {
    src: '',
    async: true,
    nonce: '',
    onload: null,
    onerror: null,
  };
}

function createContext({ inlineAssetVersion = '' } = {}) {
  const fetchCalls = [];
  const scriptLoads = [];
  const loggedErrors = [];

  const context = {
    URL,
    encodeURIComponent,
    Promise,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    fetchCalls,
    scriptLoads,
    loggedErrors,
    console: {
      error(...args) {
        loggedErrors.push(args.join(' '));
      },
      info() {},
      log() {},
      warn() {},
    },
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), options });
      return {
        ok: true,
        async json() {
          return { assetVersion: 'build-123' };
        },
      };
    },
    window: {
      __REMOTELAB_BUILD__: inlineAssetVersion ? { assetVersion: inlineAssetVersion } : undefined,
      location: {
        href: 'http://127.0.0.1/',
        origin: 'http://127.0.0.1',
      },
    },
    document: {
      currentScript: {
        nonce: 'test-nonce',
        src: 'http://127.0.0.1/chat.js',
      },
      head: {
        appendChild(script) {
          scriptLoads.push(script.src);
          queueMicrotask(() => script.onload?.());
          return script;
        },
      },
      createElement(tagName) {
        assert.equal(tagName, 'script', 'loader should append script elements');
        return createScriptElement();
      },
    },
  };

  context.globalThis = context;
  context.self = context;
  return context;
}

async function waitForLoaderWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const fallbackContext = createContext();
vm.runInNewContext(loaderSource, fallbackContext, { filename: 'static/chat.js' });
await waitForLoaderWork();

assert.equal(
  fallbackContext.fetchCalls.length,
  1,
  'compatibility loader should resolve the current asset version before loading split assets',
);
assert.equal(fallbackContext.fetchCalls[0]?.url, '/api/build-info');
assert.equal(fallbackContext.fetchCalls[0]?.options?.credentials, 'same-origin');
assert.equal(fallbackContext.fetchCalls[0]?.options?.cache, 'no-store');
assert.deepEqual(
  fallbackContext.scriptLoads,
  [
    '/marked.min.js?v=build-123',
    '/chat/session-state-model.js?v=build-123',
    '/chat/icons.js?v=build-123',
    '/chat/bootstrap.js?v=build-123',
    '/chat/bootstrap-session-catalog.js?v=build-123',
    '/chat/session-http-helpers.js?v=build-123',
    '/chat/session-http-list-state.js?v=build-123',
    '/chat/session-http.js?v=build-123',
    '/chat/layout-tooling.js?v=build-123',
    '/chat/tooling.js?v=build-123',
    '/chat/realtime.js?v=build-123',
    '/chat/realtime-render.js?v=build-123',
    '/chat/ui.js?v=build-123',
    '/chat/session-surface-ui.js?v=build-123',
    '/chat/session-list-ui.js?v=build-123',
    '/chat/settings-ui.js?v=build-123',
    '/chat/sidebar-ui.js?v=build-123',
    '/chat/compose.js?v=build-123',
    '/chat/gestures.js?v=build-123',
    '/chat/init.js?v=build-123',
  ],
  'compatibility loader should version-pin the full split frontend asset chain',
);
assert.deepEqual(fallbackContext.loggedErrors, [], 'compatibility loader should not log load errors during the happy path');

const inlineContext = createContext({ inlineAssetVersion: 'inline-build-456' });
vm.runInNewContext(loaderSource, inlineContext, { filename: 'static/chat.js' });
await waitForLoaderWork();

assert.deepEqual(
  inlineContext.fetchCalls,
  [],
  'inline build info should let the compatibility loader skip the build-info roundtrip',
);
assert.deepEqual(
  inlineContext.scriptLoads,
  [
    '/marked.min.js?v=inline-build-456',
    '/chat/session-state-model.js?v=inline-build-456',
    '/chat/icons.js?v=inline-build-456',
    '/chat/bootstrap.js?v=inline-build-456',
    '/chat/bootstrap-session-catalog.js?v=inline-build-456',
    '/chat/session-http-helpers.js?v=inline-build-456',
    '/chat/session-http-list-state.js?v=inline-build-456',
    '/chat/session-http.js?v=inline-build-456',
    '/chat/layout-tooling.js?v=inline-build-456',
    '/chat/tooling.js?v=inline-build-456',
    '/chat/realtime.js?v=inline-build-456',
    '/chat/realtime-render.js?v=inline-build-456',
    '/chat/ui.js?v=inline-build-456',
    '/chat/session-surface-ui.js?v=inline-build-456',
    '/chat/session-list-ui.js?v=inline-build-456',
    '/chat/settings-ui.js?v=inline-build-456',
    '/chat/sidebar-ui.js?v=inline-build-456',
    '/chat/compose.js?v=inline-build-456',
    '/chat/gestures.js?v=inline-build-456',
    '/chat/init.js?v=inline-build-456',
  ],
  'compatibility loader should reuse inline build info to keep split assets on the same version',
);

console.log('test-chat-loader-versioned-assets: ok');
