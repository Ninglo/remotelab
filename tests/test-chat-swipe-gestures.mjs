#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const gesturesSource = readFileSync(join(repoRoot, 'static/chat/gestures.js'), 'utf8');

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

function makeStyle() {
  const values = new Map();
  return {
    setProperty(name, value) {
      values.set(name, value);
    },
    removeProperty(name) {
      values.delete(name);
    },
    getPropertyValue(name) {
      return values.get(name) || '';
    },
  };
}

class FakeElement {
  constructor({ blocked = false } = {}) {
    this.blocked = blocked;
  }

  closest() {
    return this.blocked ? this : null;
  }
}

function createHarness() {
  const listeners = new Map();
  const gesturePill = {
    textContent: '',
    classList: makeClassList(),
    style: makeStyle(),
  };
  const sidebarOverlay = {
    classList: makeClassList(),
  };
  const context = {
    console,
    Promise,
    Element: FakeElement,
    isDesktop: false,
    visitorMode: false,
    sidebarOverlay,
    addToolModal: { hidden: true },
    openSessionsSidebarCalls: 0,
    createNewSessionShortcutCalls: 0,
    openSessionsSidebar() {
      context.openSessionsSidebarCalls += 1;
      return true;
    },
    createNewSessionShortcut() {
      context.createNewSessionShortcutCalls += 1;
      return true;
    },
    window: {
      innerWidth: 390,
    },
    document: {
      documentElement: {
        clientWidth: 390,
      },
      getElementById(id) {
        if (id === 'gesturePill') return gesturePill;
        return null;
      },
      addEventListener(type, listener) {
        const existing = listeners.get(type) || [];
        existing.push(listener);
        listeners.set(type, existing);
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(gesturesSource, context, { filename: 'static/chat/gestures.js' });
  return { context, listeners, gesturePill };
}

function emit(listeners, type, event) {
  for (const listener of listeners.get(type) || []) {
    listener(event);
  }
}

function touch(clientX, clientY) {
  return { clientX, clientY };
}

async function runSwipe(harness, {
  startX,
  startY = 420,
  moveX,
  moveY = startY,
  endX = moveX,
  endY = moveY,
  target = new FakeElement(),
} = {}) {
  let prevented = false;
  emit(harness.listeners, 'touchstart', {
    touches: [touch(startX, startY)],
    target,
  });
  emit(harness.listeners, 'touchmove', {
    touches: [touch(moveX, moveY)],
    preventDefault() {
      prevented = true;
    },
  });
  emit(harness.listeners, 'touchend', {
    changedTouches: [touch(endX, endY)],
  });
  await Promise.resolve();
  return { prevented };
}

const centerRightHarness = createHarness();
const centerRightResult = await runSwipe(centerRightHarness, {
  startX: 195,
  moveX: 258,
  endX: 286,
});
assert.equal(centerRightResult.prevented, true, 'deliberate center-right swipe should lock the gesture');
assert.equal(centerRightHarness.context.openSessionsSidebarCalls, 1, 'swiping right from the middle should open the session list');
assert.equal(centerRightHarness.context.createNewSessionShortcutCalls, 0, 'right swipe should not create a new session');

const centerLeftHarness = createHarness();
const centerLeftResult = await runSwipe(centerLeftHarness, {
  startX: 195,
  moveX: 132,
  endX: 104,
});
assert.equal(centerLeftResult.prevented, true, 'deliberate center-left swipe should lock the gesture');
assert.equal(centerLeftHarness.context.openSessionsSidebarCalls, 0, 'left swipe should not open the session list');
assert.equal(centerLeftHarness.context.createNewSessionShortcutCalls, 1, 'swiping left from the middle should create a new session');

const verticalHarness = createHarness();
const verticalResult = await runSwipe(verticalHarness, {
  startX: 200,
  moveX: 216,
  moveY: 520,
  endX: 216,
  endY: 520,
});
assert.equal(verticalResult.prevented, false, 'vertical motion should not steal scrolling');
assert.equal(verticalHarness.context.openSessionsSidebarCalls, 0, 'vertical motion should not open the session list');
assert.equal(verticalHarness.context.createNewSessionShortcutCalls, 0, 'vertical motion should not create a new session');

const blockedHarness = createHarness();
await runSwipe(blockedHarness, {
  startX: 195,
  moveX: 300,
  endX: 320,
  target: new FakeElement({ blocked: true }),
});
assert.equal(blockedHarness.context.openSessionsSidebarCalls, 0, 'blocked interactive targets should ignore swipe shortcuts');
assert.equal(blockedHarness.context.createNewSessionShortcutCalls, 0, 'blocked interactive targets should not create sessions');

console.log('test-chat-swipe-gestures: ok');
