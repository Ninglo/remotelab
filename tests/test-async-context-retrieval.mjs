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
  let enabled = true, later = [], submits = [], children = [], cancels = [], clockState = 'running', events = [];
  let acknowledge = async () => ({ accepted: true, mode: 'steer' });
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
    history: async () => later, emit: async (sessionId, event) => { events.push({ sessionId, ...event }); },
    submit: async (directory, input) => { submits.push(input); return acknowledge(input); },
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
  await runWorkAwarenessCommand(['retrieve', '--report', JSON.stringify({ findings: evidence }), '--json'], {
    stdout: { write() {} }, client: { request: async (path, options) => {
      assert.equal(options.body.action, 'report');
      assert.deepEqual(options.body.findings, evidence);
      assert.equal(options.body.report, undefined);
      return { response: { ok: true }, json: { state: 'running' } };
    } },
  });
  await assert.rejects(service.handle(parent, { action: 'report', findings: evidence }), /assigned retrieval worker/);
  const stream = await service.handle(parent, { query: '流式查询样本' });
  const worker = await store.byRunId(stream.runId);
  const report = body => service.handle(worker, { action: 'report', ...body });
  const before = submits.length;
  await report({ phase: 'work-check', phaseStatus: 'started' });
  const noHit = await report({ phase: 'work-check', phaseStatus: 'completed', findings: [] });
  assert.equal(submits.length, before, 'phase timing and no-hit reports never inject a placeholder');
  assert(noHit.phases['work-check'].durationMs >= 0);
  await report({ phase: 'supplement', phaseStatus: 'started' });
  const partial = await report({ findings: evidence });
  assert.equal(partial.state, 'running');
  assert.equal(partial.findingCount, 1);
  assert(partial.firstFindingMs >= 0 && partial.firstAcceptedMs >= partial.firstFindingMs);
  assert.equal((await store.byRunId(stream.runId)).result, null, 'first finding arrives before worker completion');
  assert.equal(submits.length, before + 1);
  assert.equal(submits.at(-1).referenceOnly, true);
  assert.equal(submits.at(-1).continuationOnly, true);
  const second = { text: '第二条独立证据', source: '/memory/second.md:2', whyUseful: '补充另一个事实' };
  await Promise.all([report({ findings: evidence }), report({ findings: [...evidence, second] })]);
  assert.equal(submits.length, before + 2, 'concurrent retry and overlapping batch only send the new finding');
  assert.notEqual(submits.at(-1).id, submits.at(-2).id);
  await report({ phase: 'supplement', phaseStatus: 'completed' });
  const finalRow = await finish(stream, [...evidence, second]);
  assert.equal(submits.length, before + 2, 'final recap does not resend partial findings');
  assert.equal(finalRow.findings.length, 2);
  assert.equal(finalRow.delivery, 'accepted');
  assert(finalRow.phases.supplement.durationMs >= 0);
  assert.equal(events.filter(e => e.retrievalId === stream.id && e.action === 'context-retrieval-finding').length, 2);
  await assert.rejects(report({ findings: evidence }), /no longer active/);

  const failPartial = await service.handle(parent, { query: '中途失败仍保留已投递证据' });
  await service.handle(await store.byRunId(failPartial.runId), { action: 'report', findings: evidence });
  const failed = await finish(failPartial, [], 'failed');
  assert.equal(failed.delivery, 'accepted'); assert.equal(failed.findings.length, 1);

  const latePartial = await service.handle(parent, { query: '逐条回传时检查最新输入' });
  const lateWorker = await store.byRunId(latePartial.runId);
  await service.handle(lateWorker, { action: 'report', findings: evidence });
  const sent = submits.length;
  later = [{ type: 'message', role: 'user', seq: 101 }];
  assert.equal((await service.handle(lateWorker, { action: 'report', findings: [second] })).stale, true);
  assert.equal(submits.length, sent, 'a later human correction prevents further injections');
  later = [];
  enabled = false;
  assert.equal((await service.handle(lateWorker, { action: 'report', findings: [] })).stale, true);
  enabled = true;
  clockState = 'completed';
  assert.equal((await service.handle(lateWorker, { action: 'report', findings: [] })).stale, true);
  clockState = 'running';
  const foreign = { ...lateWorker, runId: worker.runId };
  await assert.rejects(service.handle(foreign, { action: 'report', findings: evidence }), /no longer active/);
  await assert.rejects(service.handle(lateWorker, { action: 'report', phase: 'arbitrary', phaseStatus: 'started' }), /Invalid retrieval phase/);
  await assert.rejects(service.handle(lateWorker, { action: 'report', phase: 'supplement', phaseStatus: 'completed' }), /phase start/);

  const uncertain = await service.handle(parent, { query: '丢失回执恢复' });
  const uncertainWorker = await store.byRunId(uncertain.runId);
  acknowledge = async () => { throw Object.assign(new Error('lost acknowledgement'), { code: 'NATIVE_UNCERTAIN' }); };
  const lost = await service.handle(uncertainWorker, { action: 'report', findings: evidence });
  assert.equal(lost.uncertainCount, 1);
  const originalInput = submits.at(-1);
  acknowledge = async input => { assert.deepEqual(input, originalInput, 'retry uses identical native identity and content'); return { accepted: true }; };
  await service.handle(uncertainWorker, { action: 'report', findings: [{ ...evidence[0], whyUseful: '更换解释也不重复注入同一事实' }] });
  const recovered = await finish(uncertain, []);
  assert.equal(recovered.delivery, 'accepted'); assert.equal(recovered.findings.length, 1);
  assert.equal(recovered.state, 'completed', 'empty final preserves streamed findings');
  const { createNativeInputServer, submitNativeInput, readNativeInputReceipt } = await import('../chat/native-input-transport.mjs');
  const nativeDirectory = join(home, 'native-stream');
  const received = [];
  const native = await createNativeInputServer({ directory: nativeDirectory, isAccepting: async () => true,
    submit: async input => { received.push(input); return { accepted: true, mode: 'steer' }; } });
  try {
    acknowledge = input => submitNativeInput(nativeDirectory, input);
    const socketJob = await service.handle(parent, { query: '真实本地原生通道的隔离样本' });
    const socketWorker = await store.byRunId(socketJob.runId);
    await service.handle(socketWorker, { action: 'report', findings: evidence });
    assert.equal(received.length, 1);
    assert.equal((await store.byRunId(socketJob.runId)).result, null);
    const receipt = await readNativeInputReceipt(nativeDirectory, received[0].id);
    assert.equal(receipt.state, 'accepted');
    await submitNativeInput(nativeDirectory, received[0]);
    assert.equal(received.length, 1, 'native durable receipt prevents duplicate delivery');
    await service.handle(socketWorker, { action: 'report', findings: [second] });
    assert.equal(received.length, 2);
    await finish(socketJob, [...evidence, second]);
    assert.equal(received.length, 2);
  } finally { await native.close(); }
  assert.throws(() => parseRetrievalResult('null'), /Invalid retrieval findings/);
  console.log('PASS async retrieval: original opt-in/cancellation behavior; incremental delivery before completion, phase/no-hit timing, concurrent deduplication, empty final, partial failure, late/disabled/foreign rejection, acknowledgement recovery, report CLI and real native-socket receipt replay (isolated samples)');
} finally { await rm(home, { recursive: true, force: true }); }
