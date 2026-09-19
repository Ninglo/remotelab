#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const toolingSource = readFileSync(join(repoRoot, 'static/chat/tooling.js'), 'utf8');

const shareStart = toolingSource.indexOf('function updateCopyButtonLabel');
const shareEnd = toolingSource.indexOf('async function forkCurrentSession');
if (shareStart < 0 || shareEnd < 0 || shareEnd <= shareStart) {
  throw new Error('Failed to locate share snapshot helpers in tooling.js');
}
const shareSource = toolingSource.slice(shareStart, shareEnd);

function createContext({
  navigatorShare = null,
  copyShouldFail = false,
  baseUri = 'https://chat.example.com/',
  locationHref = 'https://chat.example.com/',
} = {}) {
  const captured = {
    navigatorPayload: null,
    copiedText: null,
    promptArgs: null,
  };
  const shareSnapshotBtn = {
    disabled: false,
    textContent: 'Share',
    dataset: {},
    style: {},
  };
  const context = {
    console,
    URL,
    encodeURIComponent,
    currentSessionId: 'session_share_1',
    shareSnapshotBtn,
    forkSessionBtn: null,
    document: {
      baseURI: baseUri,
    },
    location: {
      origin: 'https://chat.example.com',
      href: locationHref,
    },
    navigator: navigatorShare
      ? {
        share: async (payload) => {
          captured.navigatorPayload = payload;
          return navigatorShare(payload);
        },
      }
      : {},
    window: {
      clearTimeout() {},
      setTimeout() {
        return 1;
      },
      prompt(title, value) {
        captured.promptArgs = { title, value };
      },
    },
    fetch: async () => ({
      ok: true,
      async json() {
        return {
          share: {
            url: 'share/snap_1234567890abcdef1234567890abcdef1234567890abcdef',
          },
        };
      },
    }),
    copyText: async (text) => {
      captured.copiedText = text;
      if (copyShouldFail) {
        throw new Error('copy failed');
      }
    },
    syncShareButton() {},
    getCurrentSession() {
      return {
        name: 'A better share title',
        tool: 'codex',
      };
    },
    getSessionActivity() {
      return {
        run: { state: 'idle' },
        compact: { state: 'idle' },
      };
    },
  };
  context.globalThis = context;
  context.self = context;
  context.__captured = captured;
  return context;
}

const nativeShareContext = createContext({
  navigatorShare: async () => {},
});
vm.runInNewContext(shareSource, nativeShareContext, { filename: 'static/chat/tooling.js' });

await nativeShareContext.shareCurrentSessionSnapshot();

assert.equal(
  nativeShareContext.__captured.navigatorPayload?.text,
  'A better share title\nhttps://chat.example.com/share/snap_1234567890abcdef1234567890abcdef1234567890abcdef',
  'native share should use a clean title-plus-link payload',
);
assert.equal(nativeShareContext.shareSnapshotBtn.disabled, false, 'share button should recover after sharing');

const copyFallbackContext = createContext();
vm.runInNewContext(shareSource, copyFallbackContext, { filename: 'static/chat/tooling.js' });

await copyFallbackContext.shareCurrentSessionSnapshot();

assert.equal(
  copyFallbackContext.__captured.copiedText,
  'A better share title\nhttps://chat.example.com/share/snap_1234567890abcdef1234567890abcdef1234567890abcdef',
  'copy fallback should preserve the same title-plus-link share text',
);
assert.equal(copyFallbackContext.__captured.promptArgs, null, 'copy fallback should not prompt when clipboard copy succeeds');

const promptFallbackContext = createContext({ copyShouldFail: true });
vm.runInNewContext(shareSource, promptFallbackContext, { filename: 'static/chat/tooling.js' });

await promptFallbackContext.shareCurrentSessionSnapshot();

assert.equal(
  promptFallbackContext.__captured.promptArgs?.title,
  'Copy share text',
  'prompt fallback should label the shareable text clearly',
);
assert.equal(
  promptFallbackContext.__captured.promptArgs?.value,
  'A better share title\nhttps://chat.example.com/share/snap_1234567890abcdef1234567890abcdef1234567890abcdef',
  'prompt fallback should expose the same title-plus-link share text',
);

const prefixedContext = createContext({
  baseUri: 'https://chat.example.com/trial16/',
  locationHref: 'https://chat.example.com/trial16/?token=demo',
});
vm.runInNewContext(shareSource, prefixedContext, { filename: 'static/chat/tooling.js' });

await prefixedContext.shareCurrentSessionSnapshot();

assert.equal(
  prefixedContext.__captured.copiedText,
  'A better share title\nhttps://chat.example.com/trial16/share/snap_1234567890abcdef1234567890abcdef1234567890abcdef',
  'prefixed share links should stay inside the current product base path',
);

console.log('test-chat-share-snapshot-message: ok');
