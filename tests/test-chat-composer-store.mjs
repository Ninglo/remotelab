#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(
  join(repoRoot, 'static', 'chat', 'composer-store.js'),
  'utf8',
);

const context = { console };
context.globalThis = context;
context.window = context;

vm.runInNewContext(source, context, {
  filename: 'composer-store.js',
});

const storeModel = context.RemoteLabComposerStore;

assert.ok(storeModel, 'composer store should attach to the global scope');

const attachmentA = { originalName: 'shot-a.png', objectUrl: 'blob:a' };
const attachmentB = { originalName: 'shot-b.png', objectUrl: 'blob:b' };

const initialState = storeModel.createState({
  activeSessionId: 'session-a',
  drafts: {
    'session-a': 'draft a',
    'session-b': 'draft b',
  },
  attachmentsBySession: {
    'session-a': [attachmentA],
  },
});

assert.equal(storeModel.getDraftText(initialState, 'session-a'), 'draft a');
assert.equal(storeModel.getDraftText(initialState, 'session-b'), 'draft b');
assert.deepEqual(Array.from(storeModel.getAttachments(initialState, 'session-a')), [attachmentA]);
assert.equal(storeModel.hasUnsavedState(initialState, 'session-a'), true);
assert.equal(storeModel.hasAnyUnsavedState(initialState), true);

const addedAttachmentState = storeModel.addAttachments(initialState, [attachmentB], {
  sessionId: 'session-a',
});
assert.deepEqual(
  Array.from(storeModel.getAttachments(addedAttachmentState, 'session-a')),
  [attachmentA, attachmentB],
  'composer store should append attachments for the same session bucket',
);

const removedAttachmentState = storeModel.removeAttachment(addedAttachmentState, 0, {
  sessionId: 'session-a',
});
assert.deepEqual(
  Array.from(storeModel.getAttachments(removedAttachmentState, 'session-a')),
  [attachmentB],
  'composer store should remove a single attachment by index',
);

const pendingSendState = storeModel.setPendingSend(removedAttachmentState, {
  sessionId: 'session-a',
  requestId: 'req_1',
  text: 'draft a',
  images: [attachmentB],
  baselineEventSeq: 7,
  stage: 'sending',
});
assert.equal(storeModel.getPendingSend(pendingSendState)?.requestId, 'req_1');
assert.equal(storeModel.getPendingSend(pendingSendState)?.baselineEventSeq, 7);
assert.equal(storeModel.hasPendingSendForSession(pendingSendState, 'session-a'), true);

const patchedPendingSendState = storeModel.patchPendingSend(pendingSendState, {
  stage: 'uploading',
});
assert.equal(storeModel.getPendingSend(patchedPendingSendState)?.stage, 'uploading');

const processingPendingSendState = storeModel.patchPendingSend(patchedPendingSendState, {
  stage: 'processing',
});
assert.equal(storeModel.getPendingSend(processingPendingSendState)?.stage, 'processing');
assert.equal(storeModel.hasPendingSendForSession(processingPendingSendState, 'session-a'), false);
const processingOnlyState = storeModel.clearSessionState(processingPendingSendState, 'session-a', {
  clearDraft: true,
  clearAttachments: true,
});
assert.equal(storeModel.hasUnsavedState(processingOnlyState, 'session-a'), false);

const clearedPendingSendState = storeModel.clearPendingSend(processingPendingSendState, {
  requestId: 'req_1',
});
assert.equal(storeModel.getPendingSend(clearedPendingSendState), null);

const clearedSessionState = storeModel.clearSessionState(clearedPendingSendState, 'session-a', {
  clearDraft: true,
  clearAttachments: true,
});
assert.equal(storeModel.getDraftText(clearedSessionState, 'session-a'), '');
assert.deepEqual(Array.from(storeModel.getAttachments(clearedSessionState, 'session-a')), []);
assert.equal(storeModel.hasUnsavedState(clearedSessionState, 'session-a'), false);
assert.equal(storeModel.hasUnsavedState(clearedSessionState, 'session-b'), true, 'clearing one session should preserve other session drafts');

const store = storeModel.createStore({ activeSessionId: 'session-a' });
const transitions = [];
store.subscribe((state, previousState, action) => {
  transitions.push({ state, previousState, action });
});
store.dispatch({ type: 'set-draft-text', sessionId: 'session-a', text: 'hello' });
store.dispatch({ type: 'add-attachments', sessionId: 'session-a', attachments: [attachmentA] });
store.dispatch({ type: 'clear-session-state', sessionId: 'session-a', clearDraft: true, clearAttachments: true });
assert.equal(transitions.length, 3, 'composer store subscribers should observe each meaningful state transition');

console.log('test-chat-composer-store: ok');
