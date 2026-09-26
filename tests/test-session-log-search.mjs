import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-log-search-'));
setIsolatedTestHome(home);
try {
  const { createSessionLogSearch } = await import('../chat/session-log-search.mjs');
  const historyDir = join(home, 'history');
  const indexDir = join(home, 'index');
  const ids = Array.from({ length: 7 }, (_, i) => String(i + 1).repeat(32));
  let sessions = [
    { id: ids[0], name: 'Auto Research数据接入', archived: true },
    { id: ids[1], name: '数据流水线', description: 'Auto Research 下载与处理' },
    { id: ids[2], name: '早期讨论' },
    { id: ids[3], name: '不相关的对话' },
    { id: ids[4], name: 'Auto Research 内部总结', internalRole: 'classifier' },
    { id: ids[5], name: '定时数据检查', internalRole: 'scheduled_execution' },
    { id: ids[6], name: '文件正文' },
  ];
  async function events(id, items) {
    const dir = join(historyDir, id);
    await mkdir(join(dir, 'events'), { recursive: true });
    for (let i = 0; i < items.length; i++) await writeFile(join(dir, 'events', `${String(i + 1).padStart(9, '0')}.json`), JSON.stringify(items[i]));
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ latestSeq: items.length, lastEventAt: `stamp-${items.length}` }));
  }
  const message = content => ({ type: 'message', role: 'user', content });
  await events(ids[0], [message('设计 robot dataset 的训练流程')]);
  await events(ids[1], [message('怎样给 auto research 接入公开数据')]);
  await events(ids[2], [message('Auto Research 架构'), ...Array.from({ length: 80 }, () => ({ type: 'tool_result', output: 'noise' }))]);
  await events(ids[3], [message('<private>hiddenkeyword</private> <hide>hiddenkeyword</hide> unrelated'),
    { type: 'reasoning', content: 'hiddenkeyword' }, { type: 'tool_result', output: 'hiddenkeyword' },
    { type: 'message', role: 'system', content: 'hiddenkeyword' }]);
  await events(ids[5], [message('定时监控 scheduledneedle')]);
  await events(ids[6], [{ ...message('clipped preview'), bodyRef: 'evt_000000001_content', bodyField: 'content' }]);
  await mkdir(join(historyDir, ids[6], 'bodies'), { recursive: true });
  await writeFile(join(historyDir, ids[6], 'bodies', 'evt_000000001_content.txt'), 'x '.repeat(40000) + ' externalizedneedle');
  const smithUrl = 'https://smith.langchain.com/example';
  const opts = { historyDir, indexDir, list: async () => sessions,
    readCaseConfig: async () => ({}), latestCase: async id => id === ids[0] ? { url: smithUrl } : null,
    sessionHref: id => `https://remote.example.test/?session=${id}&tab=sessions` };
  let search = createSessionLogSearch(opts);
  let result = await search('Auto Research');
  assert.deepEqual(result.sessions.map(s => s.id), ids.slice(0, 3), 'title, summary and early message hits are ranked, archives included');
  assert.equal(result.sessions[0].langsmithUrl, smithUrl);
  assert.match(result.sessions[0].sessionUrl, new RegExp(ids[0]));
  assert.equal(result.sessions[1].langsmithStatus, 'missing');
  assert.equal(result.incomplete, false);
  assert.deepEqual((await search('hiddenkeyword')).sessions, [], 'hidden prompts, reasoning and tool logs are excluded');
  assert.deepEqual((await search('notfoundanywhere')).sessions, [], 'do not fill results with unrelated Sessions');
  assert.equal((await search('scheduledneedle')).sessions[0].id, ids[5]);
  assert.equal((await search('externalizedneedle')).sessions[0].id, ids[6]);
  assert.equal((await search('数据接入')).sessions[0].id, ids[0], 'Chinese phrases work without spaces');
  assert.equal((await search('ＡＵＴＯ RESEARCH')).sessions[0].id, ids[0], 'case and Unicode normalization');
  await assert.rejects(search(''), { statusCode: 400 });
  await assert.rejects(search('x'.repeat(1001)), { statusCode: 400 });

  // The disk index survives process restarts and only consumes new events.
  search = createSessionLogSearch(opts);
  await rm(join(historyDir, ids[2], 'events', '000000001.json'));
  assert.equal((await search('Auto Research')).sessions.length, 3);
  await events(ids[1], [message('怎样给 auto research 接入公开数据'), message('incrementalneedle')]);
  const [a, b] = await Promise.all([search('incrementalneedle'), search('incrementalneedle')]);
  assert.equal(a.sessions[0].id, ids[1]);
  assert.deepEqual(a, b);
  assert.equal(JSON.parse(await readFile(join(indexDir, `${ids[1]}.json`))).seq, 2);
  sessions = sessions.filter(s => s.id !== ids[2]);
  assert.equal((await search('Auto Research')).sessions.length, 2, 'deleted Sessions cannot be returned by old indexes');
  sessions[0].name = 'Renamedneedle';
  assert.equal((await search('Renamedneedle')).sessions[0].id, ids[0], 'metadata edits are immediately searchable');
  await events(ids[1], [message('resetneedle')]);
  assert.deepEqual((await search('incrementalneedle')).sessions, [], 'a truncated history rebuilds its derived index');
  await writeFile(join(indexDir, `${ids[6]}.json`), 'corrupt');
  search = createSessionLogSearch({ ...opts, latestCase: async () => { throw new Error('bad snapshot'); } });
  result = await search('externalizedneedle');
  assert.equal(result.sessions[0].langsmithStatus, 'unavailable', 'trace failures do not hide Session matches');
  await events(ids[6], [message('okay'), { ...message('bad'), bodyRef: '../../auth' }]);
  result = await search('resetneedle');
  assert.equal(result.incomplete, true, 'history failures must be disclosed instead of silently losing matches');
  assert.equal(result.sessions[0].id, ids[1]);
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log('test-session-log-search: ok');
