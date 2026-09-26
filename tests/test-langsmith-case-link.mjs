#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'remotelab-langsmith-link-'));
process.env.REMOTELAB_CONFIG_DIR = dir;
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://remote.example.test';
const { readLangSmithCaseConfig, getLatestLangSmithCase } =
  await import('../lib/langsmith-case-link.mjs');
const { buildReplyPublicationPayload } = await import('../chat/reply-publication.mjs');
const { normalizeConnectorPublicationText } = await import('../lib/connector-turn-flow.mjs');
const id = 'a'.repeat(32), projectId = '46a89fbc-9740-40b8-a646-0179aa16d7f4';
try {
  assert.equal(await readLangSmithCaseConfig(), null);
  writeFileSync(join(dir, 'langsmith-case-link.json'), JSON.stringify({ enabled: true, projectId,
    stateDir: 'langsmith-live', backfillStateDir: 'langsmith-backfill' }));
  const config = await readLangSmithCaseConfig();
  const caseEntry = { label: '查看 Agent Case',
    url: `https://remote.example.test/api/sessions/${id}/langsmith?runId=run_case1` };
  const publication = buildReplyPublicationPayload([{seq:1,type:'message',role:'assistant',content:'任务完成。'}],
    {},{includeSessionEntry:false,caseEntry});
  assert.equal(publication.caseEntry, undefined);
  assert.equal(publication.text, '任务完成。');
  for (const includeAttachmentFallback of [true, false]) {
    assert.equal(normalizeConnectorPublicationText({payload:{...publication,caseEntry}},
      {includeAttachmentFallback}), '任务完成。', 'legacy case metadata must not add a reply footer');
  }
  assert.equal(await getLatestLangSmithCase(id, config), null);
  mkdirSync(join(dir, 'langsmith-live'));
  const statePath = join(dir, 'langsmith-live', 'state.json');
  const traceId = 'a'.repeat(8)+'-'+'a'.repeat(4)+'-'+'a'.repeat(4)+'-'+'a'.repeat(4)+'-'+'a'.repeat(12);
  const childId = 'b'.repeat(8)+'-'+'b'.repeat(4)+'-'+'b'.repeat(4)+'-'+'b'.repeat(4)+'-'+'b'.repeat(12);
  const url = `https://smith.langchain.com/o/tenant/projects/p/${projectId}/trace/${traceId}/run/${traceId}`;
  writeFileSync(statePath, JSON.stringify({projectId,tracked:{[id]:{latestSnapshot:{rootUrl:url,traceId,revision:2,runNodeIds:{run_case1:childId}}}}}));
  assert.equal((await getLatestLangSmithCase(id, config)).url,url);
  assert.equal((await getLatestLangSmithCase(id, config,{runId:'run_case1'})).url,url.replace(`/run/${traceId}`,`/run/${childId}`));
  writeFileSync(statePath, JSON.stringify({projectId,tracked:{[id]:{latestSnapshot:{rootUrl:'https://evil.example/r/trace',traceId:'trace',revision:2}}}}));
  assert.equal(await getLatestLangSmithCase(id, config), null);
  mkdirSync(join(dir, 'langsmith-backfill'));
  writeFileSync(join(dir, 'langsmith-backfill', 'state.json'), JSON.stringify({projectId,sessions:{[id]:{
    latestSnapshot:{rootUrl:url,traceId,revision:1,runIds:['run_case1','run_case2'],runNodeIds:{run_case1:childId}}}}}));
  assert.equal((await getLatestLangSmithCase(id, config,{runId:'run_case1'})).url,
    url.replace(`/run/${traceId}`,`/run/${childId}`));
} finally { rmSync(dir,{recursive:true,force:true}); }
console.log('test-langsmith-case-link: ok');
