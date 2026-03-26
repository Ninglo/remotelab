#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const bootstrapSource = readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap.js'), 'utf8');

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

const hasUnsavedComposerStateSource = extractFunctionSource(bootstrapSource, 'hasUnsavedComposerState');
const applyBuildInfoSource = extractFunctionSource(bootstrapSource, 'applyBuildInfo');

async function main() {
  function buildContext({ draftText = '', pendingAttachments = 0, pendingSend = false } = {}) {
    const state = {
      reloadCalls: 0,
      refreshUiCalls: 0,
    };
    const context = {
      console,
      buildRefreshScheduled: false,
      newerBuildInfo: null,
      buildAssetVersion: 'build-a',
      msgInput: { value: draftText },
      imgPreviewStrip: { childElementCount: pendingAttachments },
      hasPendingComposerSend() {
        return pendingSend;
      },
      updateFrontendRefreshUi() {
        state.refreshUiCalls += 1;
      },
      async reloadForFreshBuild() {
        state.reloadCalls += 1;
        return true;
      },
    };
    context.globalThis = context;
    vm.runInNewContext(
      `${hasUnsavedComposerStateSource}\n${applyBuildInfoSource}\nglobalThis.hasUnsavedComposerState = hasUnsavedComposerState;\nglobalThis.applyBuildInfo = applyBuildInfo;`,
      context,
      { filename: 'static/chat/bootstrap.js' },
    );
    return { context, state };
  }

  const nextBuildInfo = { assetVersion: 'build-b', title: 'Frontend ui:build-b' };

  const { context: cleanContext, state: cleanState } = buildContext();
  const firstResult = await cleanContext.applyBuildInfo(nextBuildInfo);
  assert.equal(firstResult, false, 'new frontend builds should stay passive until the user explicitly reloads');
  assert.equal(cleanState.reloadCalls, 0, 'new frontend builds should not trigger a hidden automatic reload');
  assert.equal(cleanState.refreshUiCalls, 1, 'new frontend builds should still surface the update indicator immediately');
  assert.deepEqual(cleanContext.newerBuildInfo, nextBuildInfo, 'new frontend builds should remain tracked for the manual reload button');

  const { context: draftContext, state: draftState } = buildContext({ draftText: 'unfinished draft' });
  const draftResult = await draftContext.applyBuildInfo(nextBuildInfo);
  assert.equal(draftResult, false, 'new frontend builds should also stay passive when the composer has a draft');
  assert.equal(draftState.reloadCalls, 0, 'draft text should remain safe because reloads are always manual now');
  assert.equal(draftState.refreshUiCalls, 1, 'draft-protected pages should still surface the update indicator');
  assert.deepEqual(draftContext.newerBuildInfo, nextBuildInfo, 'draft-protected pages should remember the pending build for manual reload');

  const { context: attachmentContext, state: attachmentState } = buildContext({ pendingAttachments: 2 });
  const attachmentResult = await attachmentContext.applyBuildInfo(nextBuildInfo);
  assert.equal(attachmentResult, false, 'new frontend builds should stay passive when attachment drafts are queued');
  assert.equal(attachmentState.reloadCalls, 0, 'queued attachments should remain untouched until the user taps reload');

  draftState.refreshUiCalls = 0;
  const secondResult = await draftContext.applyBuildInfo({ assetVersion: 'build-a' });
  assert.equal(secondResult, false, 'same-version build info should stay a no-op');
  assert.equal(draftState.reloadCalls, 0, 'same-version build info should not trigger reloads');
  assert.equal(draftState.refreshUiCalls, 1, 'same-version build info should clear the indicator state');
  assert.equal(draftContext.newerBuildInfo, null, 'same-version build info should clear stale update prompts');

  console.log('test-chat-build-update-indicator: ok');
}

main().catch((error) => {
  console.error('test-chat-build-update-indicator: failed');
  console.error(error);
  process.exitCode = 1;
});
