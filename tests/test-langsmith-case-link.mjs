#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'remotelab-langsmith-link-'));
process.env.REMOTELAB_CONFIG_DIR = dir;
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://remote.example.test';
const { readLangSmithCaseConfig, getLatestLangSmithCase, getLangSmithCaseStatus } =
  await import('../lib/langsmith-case-link.mjs');
const { buildReplyPublicationPayload } = await import('../chat/reply-publication.mjs');
const { normalizeConnectorPublicationText } = await import('../lib/connector-turn-flow.mjs');
const id = 'a'.repeat(32), projectId = '46a89fbc-9740-40b8-a646-0179aa16d7f4';
try {
  assert.equal(await readLangSmithCaseConfig(), null);
  assert.equal((await getLangSmithCaseStatus(id, null)).status, 'disabled');
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
  assert.equal((await getLangSmithCaseStatus(id, config)).status, 'missing');
  mkdirSync(join(dir, 'langsmith-live'));
  const statePath = join(dir, 'langsmith-live', 'state.json');
  const traceId = 'a'.repeat(8)+'-'+'a'.repeat(4)+'-'+'a'.repeat(4)+'-'+'a'.repeat(4)+'-'+'a'.repeat(12);
  const childId = 'b'.repeat(8)+'-'+'b'.repeat(4)+'-'+'b'.repeat(4)+'-'+'b'.repeat(4)+'-'+'b'.repeat(12);
  const url = `https://smith.langchain.com/o/tenant/projects/p/${projectId}/trace/${traceId}/run/${traceId}`;
  writeFileSync(statePath, JSON.stringify({projectId,tracked:{[id]:{latestSnapshot:{rootUrl:url,traceId,revision:2,runNodeIds:{run_case1:childId}}}}}));
  assert.equal((await getLatestLangSmithCase(id, config)).url,url);
  assert.equal((await getLatestLangSmithCase(id, config,{runId:'run_case1'})).url,url.replace(`/run/${traceId}`,`/run/${childId}`));
  const canonicalUrl = `https://smith.langchain.com/o/tenant/projects/p/${projectId}/r/${traceId}?trace_id=${traceId}&start_time=2026-09-26T05:19:48.685000`;
  const snapshot = {rootUrl:canonicalUrl,traceId,revision:2,runNodeIds:{run_case1:childId}};
  const writeSnapshot = value => writeFileSync(statePath, JSON.stringify({projectId,tracked:{[id]:{latestSnapshot:value}}}));
  writeSnapshot(snapshot);
  assert.equal((await getLatestLangSmithCase(id, config)).url, canonicalUrl);
  assert.equal((await getLatestLangSmithCase(id, config,{runId:'run_case1'})).url,
    canonicalUrl.replace(`/r/${traceId}`, `/r/${childId}`), 'select a child while preserving trace and timestamp');
  assert.equal((await getLatestLangSmithCase(id, config,{runId:'run_unknown'})).url, canonicalUrl);
  for (const rootUrl of [
    `https://smith.langchain.com/o/tenant/projects/p/${projectId}/`,
    `https://smith.langchain.com/o/tenant/projects/p/${projectId}/traces`,
    canonicalUrl.replace(`/r/${traceId}`, `/r/${childId}`),
    canonicalUrl.replace(`trace_id=${traceId}`, `trace_id=${childId}`),
    canonicalUrl.replace(projectId, childId),
    url.replace(`/trace/${traceId}`, `/trace/${childId}`),
    url + '/extra',
  ]) {
    writeSnapshot({...snapshot,rootUrl});
    assert.equal(await getLatestLangSmithCase(id, config), null, `reject nonmatching root: ${rootUrl}`);
  }
  writeSnapshot(snapshot);
  assert.equal(await getLatestLangSmithCase(id, {...config,workspaceId:childId}), null, 'reject a stale workspace');
  writeFileSync(statePath, JSON.stringify({projectId,tracked:{[id]:{latestSnapshot:{rootUrl:'https://evil.example/r/trace',traceId:'trace',revision:2}}}}));
  assert.equal(await getLatestLangSmithCase(id, config), null);
  mkdirSync(join(dir, 'langsmith-backfill'));
  writeFileSync(join(dir, 'langsmith-backfill', 'state.json'), JSON.stringify({projectId,sessions:{[id]:{
    latestSnapshot:{rootUrl:url,traceId,revision:1,runIds:['run_case1','run_case2'],runNodeIds:{run_case1:childId}}}}}));
  assert.equal((await getLatestLangSmithCase(id, config,{runId:'run_case1'})).url,
    url.replace(`/run/${traceId}`,`/run/${childId}`));
  // A bad or corrupt source must not hide a valid snapshot from another source.
  writeFileSync(statePath, JSON.stringify({projectId,tracked:{[id]:{latestSnapshot:{rootUrl:'not a URL',revision:99,runIds:Array(10).fill('run_bad')}}}}));
  assert.equal((await getLatestLangSmithCase(id, config)).url, url);
  writeFileSync(statePath, 'corrupt');
  assert.equal((await getLatestLangSmithCase(id, config)).url, url);
  rmSync(statePath);
  const backfillPath = join(dir, 'langsmith-backfill', 'state.json');
  for (const status of ['pending', 'waiting', 'failed', 'unsupported', 'unsupported_timestamp', 'empty']) {
    writeFileSync(backfillPath, JSON.stringify({projectId,sessions:{[id]:{status}}}));
    assert.equal((await getLangSmithCaseStatus(id, config)).status, status);
    assert.equal(await getLatestLangSmithCase(id, config), null);
  }
  writeFileSync(statePath, JSON.stringify({projectId,tracked:{[id]:{lastError:'private error detail'}}}));
  rmSync(backfillPath);
  assert.deepEqual(await getLangSmithCaseStatus(id, config), {status:'failed'}, 'raw errors are not published');
  writeFileSync(statePath, JSON.stringify({projectId:'wrong-project',tracked:{[id]:{status:'pending'}}}));
  assert.equal((await getLangSmithCaseStatus(id, config)).status, 'unavailable');
  mkdirSync(join(dir, 'langsmith-history'));
  writeFileSync(join(dir, 'langsmith-history', 'state.json'), JSON.stringify({projectId,sessions:{[id]:{
    latestSnapshot:{rootUrl:url,traceId,revision:1,kind:'historical_import',runIds:['run_case1'],runNodeIds:{run_case1:childId}}}}}));
  config.historyStateDir = 'langsmith-history';
  const imported = await getLangSmithCaseStatus(id, config, {runId:'run_case1'});
  assert.equal(imported.kind, 'historical_import');
  assert.equal(imported.url, url.replace(`/run/${traceId}`,`/run/${childId}`));
  writeFileSync(join(dir, 'langsmith-case-link.json'), JSON.stringify({...config,historyStateDir:'../outside'}));
  await assert.rejects(readLangSmithCaseConfig(), /Invalid LangSmith historyStateDir/);
} finally { rmSync(dir,{recursive:true,force:true}); }
console.log('test-langsmith-case-link: ok');
