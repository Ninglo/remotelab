import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'memory-review-selection-'));
setIsolatedTestHome(home);
try {
  const { memoryReviewRuntimeSelection, maybeRunMemoryWriteback } = await import('../chat/session-memory-writeback.mjs');
  for (const [tool, model] of [['pi', 'openai-codex/gpt-5.6-sol'], ['codex', 'gpt-5.6-sol']]) {
    const foreground = { tool, model: 'gpt-6-astra', effort: 'high', thinking: true };
    const selected = { ...foreground, ...memoryReviewRuntimeSelection(tool) };
    assert.deepEqual(selected, { tool, model, effort: 'low', thinking: false });
    assert.equal(foreground.model, 'gpt-6-astra');
    assert.equal(foreground.effort, 'high');
    process.env.REMOTELAB_MEMORY_WRITEBACK = '1';
    let calls = 0;
    const result = await maybeRunMemoryWriteback({
      sessionId: 'isolated-review', session: foreground, run: { id: 'fixture' },
      userMessage: 'No durable learning.', assistantTurnText: 'Synthetic no-op response. '.repeat(10),
      runPrompt: async () => { calls++; return '<hide>{"shouldWrite":false,"learnings":[]}</hide>'; },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { attempted: true, written: false });
  }
  assert.equal(memoryReviewRuntimeSelection('claude').model, undefined, 'do not force an OpenAI model on other harnesses');
  const manager = await readFile(new URL('../chat/session-manager.mjs', import.meta.url), 'utf8');
  const scheduling = manager.slice(manager.indexOf('function scheduleDetachedRunMemoryWriteback('), manager.indexOf('\nasync function syncDetachedRun('));
  assert.ok(scheduling.includes('...memoryReviewRuntimeSelection(finalizedRun.tool || session.tool)'));
  assert.ok(!scheduling.includes('PRODUCT_DEFAULT_CODEX_'), 'review must not follow foreground defaults');
  assert.ok(scheduling.includes("operation: 'memory_writeback_review'"));
  console.log('PASS: independent Pi/Codex Sol/low memory review, foreground preservation, no-op fixtures and production wiring');
} finally {
  await rm(home, { recursive: true, force: true });
}
