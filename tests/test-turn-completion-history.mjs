import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await fs.mkdtemp(join(tmpdir(), 'remotelab-completion-history-'));
setIsolatedTestHome(home);
const originalReadFile = fs.readFile;
const eventReads = [];
fs.readFile = async function (path, ...args) {
  if (String(path).includes('/events/')) eventReads.push(String(path));
  return originalReadFile.call(this, path, ...args);
};
syncBuiltinESMExports();

try {
  const { CHAT_HISTORY_DIR } = await import('../lib/config.mjs');
  const { loadHistory, readLastTurnEvents } = await import('../chat/history.mjs');
  const { createSessionTurnCompletionHelpers } = await import('../chat/session-turn-completion.mjs');
  const source = { runId: 'run_current', requestId: 'input_latest' };
  const latestBody = 'Current image: ![draft](/tmp/draft.png)\n'.repeat(100);
  const fixtures = [
    { id: 'long-history', events: [
      { seq: 1, type: 'message', role: 'user', content: 'original request', runId: source.runId, requestId: 'input_original' },
      { seq: 2, type: 'message', role: 'assistant', content: 'old image: ![old](/tmp/old.png)' },
      { seq: 10000, type: 'message', role: 'user', content: 'new input in same run', ...source },
      { seq: 10001, type: 'message', role: 'assistant', content: 'preview', ...source,
        bodyRef: 'latest', bodyField: 'content', bodyLoaded: false, bodyAvailable: true },
      { seq: 10002, type: 'attachment_delivery', ...source, attachments: [{ originalName: 'draft.png' }] },
    ], expected: [10001, 10002] },
    { id: 'no-user', events: [{ seq: 1, type: 'message', role: 'assistant', content: 'assistant-only result' }], expected: [1] },
    { id: 'empty', events: [], expected: [] },
  ];
  for (const fixture of fixtures) {
    const dir = join(CHAT_HISTORY_DIR, fixture.id);
    await fs.mkdir(join(dir, 'events'), { recursive: true });
    await fs.mkdir(join(dir, 'bodies'), { recursive: true });
    await fs.writeFile(join(dir, 'meta.json'), JSON.stringify({ latestSeq: fixture.events.at(-1)?.seq || 0 }));
    await fs.writeFile(join(dir, 'bodies', 'latest.txt'), latestBody);
    for (const event of fixture.events) {
      await fs.writeFile(join(dir, 'events', `${String(event.seq).padStart(9, '0')}.json`), JSON.stringify(event));
    }
    let selected, publication;
    const helpers = createSessionTurnCompletionHelpers({
      loadHistory, readLastTurnEvents,
      findAssistantAttachmentMessageForRun: async () => false,
      findResultAssetMessageForRun: async () => false,
      normalizePublishedResultAssetAttachments: assets => assets,
      collectAssistantLocalMarkdownImageRewrites: async (_, events) => { selected = events; return []; },
      buildResultAssetReadyMessage: () => 'result ready',
      appendAssistantMessage: async (...args) => { publication = args; },
    });
    eventReads.length = 0;
    const run = { id: source.runId, requestId: source.requestId, responseId: 'response_current', publishedResultAssets: [{ assetId: 'asset_current' }] };
    assert.equal(await helpers.maybePublishRunResultAssets(fixture.id, run, {}, []), true);
    assert.deepEqual(selected.map(event => event.seq), fixture.expected);
    assert.equal(publication[3].requestId, source.requestId);
    assert.equal(publication[3].resultRunId, source.runId);
    assert.equal(publication[3].responseId, 'response_current');
    if (fixture.id === 'long-history') {
      assert.equal(selected[0].content, latestBody, 'current text is hydrated in full');
      assert.equal(selected[1].attachments[0].originalName, 'draft.png');
      assert.equal(eventReads.length, 3, 'result publication only reads the latest turn, regardless of older history size');
      assert(eventReads.every(path => /00001000[012]\.json$/.test(path)), 'older turns must not enter the read/cache path');
    }
  }
  console.log('Turn completion: bounded recent-history reads, full text, attachments, input attribution, empty and userless histories passed.');
} finally {
  fs.readFile = originalReadFile;
  syncBuiltinESMExports();
  await fs.rm(home, { recursive: true, force: true });
}
