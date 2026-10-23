import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'async-retrieval-test-'));
setIsolatedTestHome(home);
try {
  const { createRequestStore } = await import('../chat/requests.mjs');
  const { createAsyncContextRetrieval, parseRetrievalResult, RETRIEVAL_OPERATION } = await import('../chat/async-context-retrieval.mjs');
  const { runWorkAwarenessCommand } = await import('../lib/work-awareness-command.mjs');
  const store = createRequestStore(join(home, 'requests'));
  const source = { id: 'source', folder: home, tool: 'codex', model: 'gpt-6-astra', effort: 'xhigh' };
  const person = 'person_alice', identity = 'identity_alice';
  let enabled = true, later = [], submits = [], children = [], cancels = [], clockState = 'running';
  const runs = new Map(), sessions = new Map([[source.id, source]]);
  const parent = (await store.accept({ sessionId: source.id, requestId: 'human', text: '测试个人异步检索',
    options: { viewPersonId: person, initiatedByIdentityId: identity } })).record;
  runs.set(parent.runId, { id: parent.runId, sessionId: source.id, state: 'running', ...source });
  const manager = {
    createSession: async (folder, tool, name, options) => {
      const old = children.find(c => c.externalTriggerId === options.externalTriggerId);
      if (old) return old;
      const child = { id: 'child' + children.length, folder, tool, ...options };
      children.push(child); sessions.set(child.id, child); return child;
    },
    submitHttpMessage: async (sessionId, prompt, images, options) => {
      assert.equal(options.internalOperation, RETRIEVAL_OPERATION);
      assert.equal(options.recordUserMessage, false);
      assert.equal(options.suppressSourceDelivery, true);
      assert.equal(options.sourceDelivery, undefined);
      assert.match(prompt, /不要求用户统一叫法|不能要求用户统一叫法/);
      const record = (await store.accept({ sessionId, requestId: options.requestId, text: prompt, options })).record;
      const run = { id: record.runId, sessionId, state: 'running' }; runs.set(run.id, run);
      return { run };
    },
    cancelActiveRun: async (sessionId, options) => { cancels.push({ sessionId, ...options }); },
  };
  const service = createAsyncContextRetrieval({ store, manager,
    verify: (p, i) => p === person && i === identity ? { personId: p, identityId: i } : null,
    policy: async o => ({ scope: 'person', personId: o.viewPersonId, strictStartCheck: enabled, strictStartRuleVersion: 'v5' }),
    getRun: async id => id === parent.runId ? { ...runs.get(id), state: clockState } : runs.get(id),
    findSession: async id => sessions.get(id), snapshot: async () => ({ latestSeq: 100 }),
    history: async () => later, emit: async () => {},
    submit: async (directory, input) => { submits.push(input); return { accepted: true, mode: 'steer' }; },
  });
  const finish = async (job, findings, state = 'completed') => {
    const r = await store.byRunId(job.runId);
    const settled = await store.settle(r.key, { state, payload: { text: JSON.stringify({ findings }) } });
    assert.equal(settled.postCompletionPending, true, 'internal retrieval must recover its completion effect');
    runs.get(job.runId).state = state;
    await service.complete(settled);
    return (await store.get(parent.key)).contextRetrievals.find(j => j.id === job.id);
  };
  const evidence = [{ text: '已找到相关资料', source: '/memory/source.md:12', whyUseful: '解释当前操作来源' }];
  const first = await service.handle(parent, { query: '这次动作前的特殊 reset', context: '正在核对初始位姿' });
  assert.equal(first.state, 'running');
  assert.equal(submits.length, 0, 'admission does not wait for retrieval or inject placeholders');
  assert.equal((await service.handle(parent, { query: first.query, context: '正在核对初始位姿' })).duplicate, true);
  assert.equal(children.length, 1, 'retry creates no duplicate worker');
  assert.equal((await finish(first, evidence)).delivery, 'accepted');
  assert.equal(submits[0].referenceOnly, true);
  assert.equal(submits[0].continuationOnly, true);
  await service.complete(await store.byRunId(first.runId));
  assert.equal(submits.length, 1, 'completion replay does not duplicate delivery');
  const empty = await service.handle(parent, { query: '没有新增证据的问题' });
  assert.equal((await finish(empty, [])).state, 'empty');
  assert.equal(submits.length, 1);
  const stale = await service.handle(parent, { query: '旧目标背景' });
  later = [{ type: 'message', role: 'user', seq: 101 }];
  assert.equal((await finish(stale, evidence)).state, 'stale', 'new human input invalidates prior retrieval');
  later = [];
  const ended = await service.handle(parent, { query: '迟到资料' });
  clockState = 'completed';
  assert.equal((await finish(ended, evidence)).state, 'stale');
  clockState = 'running';
  const disabled = await service.handle(parent, { query: '关闭后资料' });
  enabled = false;
  assert.equal((await finish(disabled, evidence)).state, 'stale');
  await assert.rejects(service.handle(parent, { query: '不应启动' }), /enabled v5/);
  enabled = true;
  const wrongPerson = (await store.accept({ sessionId: 'source', requestId: 'bob', text: '别人的输入',
    options: { viewPersonId: 'person_bob', initiatedByIdentityId: identity } })).record;
  await assert.rejects(service.handle(wrongPerson, { query: '不应启动' }), /verified requester/);
  const recursive = await store.byRunId(first.runId);
  await assert.rejects(service.handle(recursive, { query: '递归检索' }), /verified requester/);
  assert.equal(submits.length, 1);
  const active = await service.handle(parent, { query: '原工作结束时停止检索' });
  await service.complete(await store.get(parent.key));
  assert(cancels.some(c => c.expectedRunId === active.runId));
  assert.throws(() => parseRetrievalResult('{"findings":[{"text":"无来源"}]}'), /source/);
  let payload;
  await runWorkAwarenessCommand(['retrieve', '--query', '网站入口', '--context', '正在做后训任务', '--source-request', 'actual', '--json'], {
    stdout: { write() {} }, client: { request: async (path, options) => {
      assert.equal(path, '/api/work-awareness/retrieve'); payload = options.body;
      return { response: { ok: true }, json: { state: 'running' } };
    } },
  });
  assert.equal(payload.sourceRequestId, 'actual');
  assert.equal(payload.context, '正在做后训任务');
  console.log('PASS async retrieval: identity, opt-in, async admission, deduplication, empty/stale/disabled delivery, completion replay, cancellation and CLI');
} finally { await rm(home, { recursive: true, force: true }); }
