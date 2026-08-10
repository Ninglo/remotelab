#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const responsiveSource = readFileSync(join(repoRoot, 'static/chat/layout-tooling.js'), 'utf8');
const messageCssSource = readFileSync(join(repoRoot, 'static/chat/chat-messages.css'), 'utf8');

assert.match(
  messageCssSource,
  /\.messages\s*\{[^}]*overflow-anchor:\s*none;/s,
  'the transcript should disable native scroll anchoring so it cannot compete with the shared viewport controller',
);

function makeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add(...tokens) {
      tokens.forEach((token) => values.add(token));
    },
    remove(...tokens) {
      tokens.forEach((token) => values.delete(token));
    },
    toggle(token, force) {
      if (typeof force === 'boolean') {
        if (force) values.add(token);
        else values.delete(token);
        return force;
      }
      if (values.has(token)) {
        values.delete(token);
        return false;
      }
      values.add(token);
      return true;
    },
    contains(token) {
      return values.has(token);
    },
  };
}

function createMatchMedia(initialMatch) {
  const listeners = [];
  return {
    matches: initialMatch,
    addEventListener(type, listener) {
      if (type === 'change') listeners.push(listener);
    },
    dispatch(nextMatch) {
      this.matches = nextMatch;
      for (const listener of listeners) listener({ matches: nextMatch });
    },
  };
}

function createContext({
  isDesktop = false,
  innerHeight = 812,
  visualHeight = 812,
  visualOffsetTop = 0,
} = {}) {
  const documentElementStyle = new Map();
  const documentElement = {
    clientHeight: innerHeight,
    style: {
      setProperty(name, value) {
        documentElementStyle.set(name, value);
      },
    },
    classList: makeClassList(),
  };
  const body = {
    classList: makeClassList(),
  };
  const resizeListeners = [];
  const viewportResizeListeners = [];
  const viewportScrollListeners = [];
  const animationFrames = [];
  const scrollCalls = [];
  const messageScrollListeners = [];
  const messageUserIntentListeners = [];
  const messageResizeObserverCallbacks = [];
  const messageMutationObserverCallbacks = [];
  const mq = createMatchMedia(isDesktop);
  const focusCalls = [];
  const messagesEl = {
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    getBoundingClientRect() {
      return { top: 0, bottom: this.clientHeight };
    },
    addEventListener(type, listener) {
      if (type === 'scroll') messageScrollListeners.push(listener);
      if (['pointerdown', 'touchstart', 'wheel', 'keydown'].includes(type)) {
        messageUserIntentListeners.push(listener);
      }
    },
  };
  const messagesInner = { children: [] };
  const msgInput = {
    focus(options) {
      focusCalls.push(options ?? null);
      context.document.activeElement = msgInput;
    },
  };
  const windowTarget = {
    innerHeight,
    scrollTo(...args) {
      scrollCalls.push(args);
    },
    addEventListener(type, listener) {
      if (type === 'resize') resizeListeners.push(listener);
    },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    matchMedia() {
      return mq;
    },
    visualViewport: {
      get height() {
        return visualHeight;
      },
      get offsetTop() {
        return visualOffsetTop;
      },
      addEventListener(type, listener) {
        if (type === 'resize') viewportResizeListeners.push(listener);
        if (type === 'scroll') viewportScrollListeners.push(listener);
      },
    },
  };
  const context = {
    console,
    isDesktop,
    messagesEl,
    messagesInner,
    sidebarOverlay: {
      classList: makeClassList(),
    },
    msgInput,
    document: {
      documentElement,
      body,
      activeElement: null,
    },
    window: windowTarget,
    ResizeObserver: class ResizeObserver {
      constructor(callback) {
        messageResizeObserverCallbacks.push(callback);
      }
      observe() {}
    },
    MutationObserver: class MutationObserver {
      constructor(callback) {
        messageMutationObserverCallbacks.push(callback);
      }
      observe() {}
    },
  };
  context.globalThis = context;
  return {
    context,
    documentElementStyle,
    body,
    mq,
    messagesEl,
    messagesInner,
    resizeListeners,
    viewportResizeListeners,
    viewportScrollListeners,
    scrollCalls,
    messageScrollListeners,
    messageUserIntentListeners,
    messageResizeObserverCallbacks,
    messageMutationObserverCallbacks,
    focusCalls,
    flushAnimationFrames() {
      const callbacks = animationFrames.splice(0, animationFrames.length);
      callbacks.forEach((callback) => callback());
    },
    flushAllAnimationFrames(limit = 12) {
      for (let index = 0; index < limit && animationFrames.length > 0; index += 1) {
        const callbacks = animationFrames.splice(0, animationFrames.length);
        callbacks.forEach((callback) => callback());
      }
    },
    dispatchMessageScroll() {
      messageScrollListeners.forEach((listener) => listener());
    },
    dispatchMessageUserIntent() {
      messageUserIntentListeners.forEach((listener) => listener());
    },
    dispatchMessageResize() {
      messageResizeObserverCallbacks.forEach((callback) => callback([]));
    },
    dispatchMessageMutation() {
      messageMutationObserverCallbacks.forEach((callback) => callback([]));
    },
    setViewport(nextHeight) {
      visualHeight = nextHeight;
    },
    setInnerHeight(nextHeight) {
      innerHeight = nextHeight;
      windowTarget.innerHeight = nextHeight;
      documentElement.clientHeight = nextHeight;
    },
    setViewportOffsetTop(nextOffsetTop) {
      visualOffsetTop = nextOffsetTop;
    },
    setActiveElement(nextActiveElement) {
      context.document.activeElement = nextActiveElement || null;
    },
    setMessageViewport(nextViewport = {}) {
      if (Number.isFinite(nextViewport.scrollHeight)) {
        messagesEl.scrollHeight = nextViewport.scrollHeight;
      }
      if (Number.isFinite(nextViewport.scrollTop)) {
        messagesEl.scrollTop = nextViewport.scrollTop;
      }
      if (Number.isFinite(nextViewport.clientHeight)) {
        messagesEl.clientHeight = nextViewport.clientHeight;
      }
    },
  };
}

const mobileHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
});
vm.runInNewContext(responsiveSource, mobileHarness.context, { filename: 'static/chat/layout-tooling.js' });

assert.ok(mobileHarness.context.window.RemoteLabLayout, 'tooling should expose a single shared layout controller');

mobileHarness.context.syncViewportHeight();
assert.equal(mobileHarness.documentElementStyle.get('--app-height'), '812px', 'app shell should track the active viewport height');
assert.equal(mobileHarness.documentElementStyle.get('--keyboard-inset-height'), '0px', 'keyboard inset should default to zero when the viewport is fully open');
assert.equal(mobileHarness.body.classList.contains('keyboard-open'), false, 'keyboard-open should stay off when no keyboard inset exists');
assert.equal(mobileHarness.scrollCalls.length, 0, 'mobile layout sync should not issue page-level scroll resets during ordinary viewport alignment');

mobileHarness.setViewportOffsetTop(42);
mobileHarness.context.syncViewportHeight();
assert.equal(mobileHarness.scrollCalls.length, 0, 'positive visual viewport offsets alone should not yank the chat back upward');

mobileHarness.setViewport(498);
mobileHarness.context.syncViewportHeight();
assert.equal(mobileHarness.scrollCalls.length, 0, 'keyboard-sized viewport shrink should not trigger page-level scroll correction while the composer is unfocused');

mobileHarness.setActiveElement(mobileHarness.context.msgInput);
mobileHarness.context.syncViewportHeight();
assert.equal(mobileHarness.documentElementStyle.get('--app-height'), '498px', 'app shell should shrink with the keyboard-aware visual viewport');
assert.equal(mobileHarness.documentElementStyle.get('--keyboard-inset-height'), '314px', 'keyboard inset should be derived from layout minus visual viewport height');
assert.equal(mobileHarness.body.classList.contains('keyboard-open'), true, 'mobile shells should enter keyboard-open mode when the keyboard consumes meaningful space');
assert.equal(mobileHarness.scrollCalls.length, 0, 'layout state sync should not write page-level scroll during keyboard-sized viewport changes');

mobileHarness.setInnerHeight(700);
mobileHarness.setViewport(700);
mobileHarness.setViewportOffsetTop(0);
mobileHarness.context.syncViewportHeight();
assert.equal(mobileHarness.documentElementStyle.get('--keyboard-inset-height'), '0px', 'keyboard inset should clear once the layout and visual viewports realign');
assert.equal(mobileHarness.body.classList.contains('keyboard-open'), false, 'keyboard-open should clear once the viewport is fully restored');

const layoutNotifications = [];
mobileHarness.context.window.RemoteLabLayout.subscribe((state, reason) => {
  layoutNotifications.push({ state, reason });
});
mobileHarness.setViewport(520);
mobileHarness.context.requestLayoutPass('viewport-a');
mobileHarness.context.requestLayoutPass('viewport-b');
assert.equal(layoutNotifications.length, 0, 'layout pass requests should batch until the next animation frame');
mobileHarness.flushAnimationFrames();
assert.equal(layoutNotifications.length, 1, 'multiple layout requests in one frame should collapse into a single pass');
assert.equal(layoutNotifications[0].reason, 'viewport-b', 'the latest queued reason should win for a batched layout pass');
assert.equal(layoutNotifications[0].state.viewportHeight, 520, 'subscribers should receive the resolved viewport height from the unified pass');

assert.equal(mobileHarness.context.focusComposer(), false, 'mobile session attachment should no longer auto-focus the composer by default');
assert.deepEqual(mobileHarness.focusCalls, [], 'mobile default focus policy should not trigger the keyboard implicitly');
assert.equal(mobileHarness.context.focusComposer({ force: true, preventScroll: true }), true, 'forced focus should still be available when the app needs recovery input');
assert.equal(mobileHarness.focusCalls.length, 1, 'forced focus should invoke the composer exactly once');
assert.equal(mobileHarness.focusCalls[0]?.preventScroll, true, 'forced focus should request preventScroll for steadier mobile viewport behavior');

const pinnedBottomHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
});
vm.runInNewContext(responsiveSource, pinnedBottomHarness.context, { filename: 'static/chat/layout-tooling.js' });
pinnedBottomHarness.context.syncViewportHeight();
pinnedBottomHarness.setMessageViewport({
  scrollHeight: 2400,
  clientHeight: 600,
  scrollTop: 1700,
});
pinnedBottomHarness.setViewport(760);
pinnedBottomHarness.context.syncViewportHeight();
assert.equal(
  pinnedBottomHarness.messagesEl.scrollTop,
  2400,
  'mobile viewport height changes should keep the message viewport pinned when the user was already at the bottom',
);

const readingHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
});
vm.runInNewContext(responsiveSource, readingHarness.context, { filename: 'static/chat/layout-tooling.js' });
readingHarness.context.syncViewportHeight();
readingHarness.setMessageViewport({
  scrollHeight: 2400,
  clientHeight: 600,
  scrollTop: 1200,
});
readingHarness.setViewport(760);
readingHarness.context.syncViewportHeight();
assert.equal(
  readingHarness.messagesEl.scrollTop,
  1200,
  'mobile viewport changes should not steal scroll position when the user is reading older messages above the bottom',
);

const offsetOnlyHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
});
vm.runInNewContext(responsiveSource, offsetOnlyHarness.context, { filename: 'static/chat/layout-tooling.js' });
offsetOnlyHarness.context.syncViewportHeight();
offsetOnlyHarness.setMessageViewport({
  scrollHeight: 2400,
  clientHeight: 600,
  scrollTop: 1700,
});
offsetOnlyHarness.setViewportOffsetTop(26);
offsetOnlyHarness.context.syncViewportHeight();
assert.equal(
  offsetOnlyHarness.messagesEl.scrollTop,
  1700,
  'visual viewport offset-only changes should not repin the transcript to the bottom while the user is simply reading',
);

const helperHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
});
vm.runInNewContext(responsiveSource, helperHarness.context, { filename: 'static/chat/layout-tooling.js' });
helperHarness.context.syncViewportHeight();
helperHarness.setMessageViewport({
  scrollHeight: 2400,
  clientHeight: 600,
  scrollTop: 1700,
});
let helperMutated = false;
helperHarness.context.window.RemoteLabLayout.preserveBottomPinnedMessageViewport(() => {
  helperMutated = true;
  helperHarness.messagesEl.clientHeight = 560;
}, { reason: 'helper-unit-test' });
helperHarness.flushAnimationFrames();
assert.equal(helperMutated, true, 'the shared bottom-pinning helper should still run the caller mutation');
assert.equal(
  helperHarness.messagesEl.scrollTop,
  2400,
  'the shared bottom-pinning helper should restore the mobile message viewport to the bottom after composer-height mutations',
);

const helperLayoutLoopHarness = createContext({
  isDesktop: true,
  innerHeight: 900,
  visualHeight: 900,
});
vm.runInNewContext(responsiveSource, helperLayoutLoopHarness.context, { filename: 'static/chat/layout-tooling.js' });
helperLayoutLoopHarness.context.syncViewportHeight();
helperLayoutLoopHarness.setMessageViewport({
  scrollHeight: 2400,
  clientHeight: 600,
  scrollTop: 1800,
});
let helperLayoutSubscriberCalls = 0;
helperLayoutLoopHarness.context.window.RemoteLabLayout.subscribe(() => {
  helperLayoutSubscriberCalls += 1;
  helperLayoutLoopHarness.context.window.RemoteLabLayout.preserveBottomPinnedMessageViewport(() => {
    helperLayoutLoopHarness.messagesEl.clientHeight = 560;
  }, { reason: 'subscriber-helper-loop-test' });
});
helperLayoutLoopHarness.context.requestLayoutPass('subscriber-helper-loop-test');
helperLayoutLoopHarness.flushAnimationFrames();
assert.equal(
  helperLayoutSubscriberCalls,
  1,
  'bottom-pinning from a layout subscriber should not enqueue a second layout pass',
);
helperLayoutLoopHarness.flushAnimationFrames();
assert.equal(
  helperLayoutSubscriberCalls,
  1,
  'bottom-pinning should not create a requestAnimationFrame layout loop on desktop',
);
assert.equal(
  helperLayoutLoopHarness.messagesEl.scrollTop,
  2400,
  'the shared bottom-pinning contract should keep desktop at the bottom too',
);

const helperReadingHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
});
vm.runInNewContext(responsiveSource, helperReadingHarness.context, { filename: 'static/chat/layout-tooling.js' });
helperReadingHarness.context.syncViewportHeight();
helperReadingHarness.setMessageViewport({
  scrollHeight: 2400,
  clientHeight: 600,
  scrollTop: 1200,
});
helperReadingHarness.context.window.RemoteLabLayout.preserveBottomPinnedMessageViewport(() => {
  helperReadingHarness.messagesEl.clientHeight = 560;
}, { reason: 'helper-reading-test' });
helperReadingHarness.flushAnimationFrames();
assert.equal(
  helperReadingHarness.messagesEl.scrollTop,
  1200,
  'the shared bottom-pinning helper should leave older reading positions untouched when the user is not near the bottom',
);

const streamingFollowHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
});
vm.runInNewContext(responsiveSource, streamingFollowHarness.context, { filename: 'static/chat/layout-tooling.js' });
streamingFollowHarness.context.initResponsiveLayout();
streamingFollowHarness.flushAllAnimationFrames();
streamingFollowHarness.setMessageViewport({
  scrollHeight: 2400,
  clientHeight: 600,
  scrollTop: 1800,
});
streamingFollowHarness.dispatchMessageScroll();
streamingFollowHarness.setMessageViewport({ scrollHeight: 3000 });
streamingFollowHarness.dispatchMessageMutation();
streamingFollowHarness.flushAllAnimationFrames();
assert.equal(
  streamingFollowHarness.messagesEl.scrollTop,
  3000,
  'streaming content growth should stay pinned when the user was following the bottom before the growth',
);

streamingFollowHarness.dispatchMessageUserIntent();
streamingFollowHarness.setMessageViewport({ scrollTop: 1000 });
streamingFollowHarness.dispatchMessageScroll();
streamingFollowHarness.setMessageViewport({ scrollHeight: 3400 });
streamingFollowHarness.dispatchMessageMutation();
streamingFollowHarness.flushAllAnimationFrames();
assert.equal(
  streamingFollowHarness.messagesEl.scrollTop,
  1000,
  'streaming growth must not steal the viewport after the user scrolls up to read older text',
);
assert.ok(
  streamingFollowHarness.context.window.RemoteLabTranscriptViewport.getDebugState().trace.length > 0,
  'the viewport controller should retain a bounded reason trace for future device-specific diagnosis',
);

const redrawAnchorHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
});
vm.runInNewContext(responsiveSource, redrawAnchorHarness.context, { filename: 'static/chat/layout-tooling.js' });
const makeTranscriptNode = (key, documentTop, height) => ({
  dataset: { transcriptKey: key },
  getBoundingClientRect() {
    const top = documentTop - redrawAnchorHarness.messagesEl.scrollTop;
    return { top, bottom: top + height };
  },
});
redrawAnchorHarness.setMessageViewport({
  scrollHeight: 2400,
  clientHeight: 600,
  scrollTop: 1050,
});
redrawAnchorHarness.messagesInner.children = [
  makeTranscriptNode('1:message', 0, 1000),
  makeTranscriptNode('2:message', 1000, 300),
  makeTranscriptNode('3:message', 1300, 1100),
];
const redrawSnapshot = redrawAnchorHarness.context.window.RemoteLabTranscriptViewport.capture({
  reason: 'redraw-regression',
});
redrawAnchorHarness.setMessageViewport({
  scrollHeight: 2000,
  scrollTop: 0,
});
redrawAnchorHarness.messagesInner.children = [
  makeTranscriptNode('1:message', 0, 600),
  makeTranscriptNode('2:message', 600, 300),
  makeTranscriptNode('3:message', 900, 1100),
];
redrawAnchorHarness.context.window.RemoteLabTranscriptViewport.restore(redrawSnapshot, {
  reason: 'redraw-regression',
});
redrawAnchorHarness.flushAllAnimationFrames();
assert.equal(
  redrawAnchorHarness.messagesEl.scrollTop,
  650,
  'a full transcript redraw should restore the same visible event and offset instead of falling back to old text at the top',
);

const desktopHarness = createContext({
  isDesktop: true,
  innerHeight: 900,
  visualHeight: 900,
});
vm.runInNewContext(responsiveSource, desktopHarness.context, { filename: 'static/chat/layout-tooling.js' });
desktopHarness.context.sidebarOverlay.classList.add('open');
desktopHarness.context.sidebarOverlay.classList.add('collapsed');
desktopHarness.context.initResponsiveLayout();

assert.equal(desktopHarness.resizeListeners.length, 1, 'layout init should watch window resize in one place');
assert.equal(desktopHarness.viewportResizeListeners.length, 1, 'layout init should watch visual viewport resize in one place');
assert.equal(desktopHarness.viewportScrollListeners.length, 1, 'layout init should watch visual viewport scroll in one place');
assert.equal(desktopHarness.context.sidebarOverlay.classList.contains('open'), false, 'desktop breakpoint init should clear any transient mobile overlay state');
assert.equal(desktopHarness.context.sidebarOverlay.classList.contains('collapsed'), false, 'desktop breakpoint init should keep the sidebar fully expanded');
assert.equal(desktopHarness.context.focusComposer({ preventScroll: true }), true, 'desktop session attachment should still auto-focus the composer');
assert.equal(desktopHarness.focusCalls.length, 1, 'desktop focus should invoke the composer exactly once');
assert.equal(desktopHarness.focusCalls[0]?.preventScroll, true, 'desktop focus should pass through preventScroll when requested');

desktopHarness.body.classList.add('keyboard-open');
desktopHarness.mq.dispatch(true);
assert.equal(desktopHarness.body.classList.contains('keyboard-open'), false, 'desktop breakpoint changes should clear any stale mobile keyboard state');

console.log('test-chat-tooling-layout: ok');
