import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceObservation, selectObservation, observationCandidates, usableSummaryText, DEFAULT_POLICY } from '../display/companion-observation.mjs';

const now = Date.parse('2026-10-20T05:00:00Z');
const options = { personId: 'person-test', identityIds: new Set(['self', 'self-feishu']) };
const session = (id = 'one', overrides = {}) => ({
  id, name: '副屏动作', initiatedByIdentityId: 'self', lastAssistantMessageAt: new Date(now - 60_000).toISOString(),
  activity: { run: { state: 'idle', waiting: false } },
  workSummary: { knownConclusions: ['三段样例保留完整动作；实机效果仍需本人确认。'], needsFromUser: ['请确认屏幕上的动作是否完整。'] },
  ...overrides,
});
const waiting = { run: { state: 'running', waiting: true } };

test('identity, archived and internal session filters use actual initiator', () => {
  const own = session();
  const data = [own, session('other', { initiatedByIdentityId: 'foreign', createdByPersonId: options.personId }),
    session('archived', { archived: true }), session('internal', { internalRole: 'delegate' }),
    session('system', { initiatedByIdentityId: 'system' })];
  assert.deepEqual(observationCandidates(data, options, now).map(item => item.sessionId), ['one']);
  assert.throws(() => selectObservation(data, { ...options, identityIds: new Set() }, now), /identityIds/);
  assert.equal(selectObservation([session('also', { initiatedByIdentityId: 'self-feishu' })], options, now).sessionId, 'also');
});
test('only genuine active waiting promotes needsFromUser; workflow flag alone does not', () => {
  const input = [session('result'), session('question', { activity: waiting })];
  const chosen = selectObservation(input, options, now);
  assert.equal(chosen.kind, 'attention');
  assert.equal(chosen.sessionId, 'question');
  assert.equal(chosen.source.field, 'workSummary.needsFromUser');
  assert.equal(selectObservation([session('idle', { workflowState: 'waiting_user' })], options, now).kind, 'result');
  assert.equal(selectObservation([session('cancel', { activity: { run: { state: 'running', waiting: true, cancelRequested: true } } })], options, now).kind, 'quiet');
});
test('running, queued, compacting, unknown and missing activity never present old conclusions', () => {
  for (const activity of [
    { run: { state: 'running', waiting: false } },
    { run: { state: 'idle' }, queue: { count: 1 } },
    { run: { state: 'idle' }, compact: { state: 'pending' } },
    { run: { state: 'completed' } }, { run: { state: 'unknown' } }, null,
  ]) assert.equal(selectObservation([session('skip', { activity })], options, now).kind, 'quiet');
});
test('no lastEventAt/updatedAt/creation time substitute; reject stale/future/ambiguous dates', () => {
  for (const lastAssistantMessageAt of [undefined, '2026-10-20T12:59', 'bad', new Date(now + 1).toISOString(),
    new Date(now - DEFAULT_POLICY.maxAgeMs).toISOString()]) {
    assert.equal(selectObservation([session('skip', { lastAssistantMessageAt, updatedAt: new Date(now).toISOString() })], options, now).kind, 'quiet');
  }
  assert.equal(selectObservation([session('epoch', { lastAssistantMessageAt: now - 1 })], options, now).observedAt, new Date(now - 1).toISOString());
});
test('most recent valid idle conclusion wins and says conversation update', () => {
  const selected = selectObservation([session('old'), session('new', { lastAssistantMessageAt: new Date(now - 1000).toISOString() })], options, now);
  assert.equal(selected.sessionId, 'new');
  assert.equal(selected.label, '对话更新');
  assert.equal(selected.source.timeField, 'lastAssistantMessageAt');
  assert.equal(selected.sentence, session().workSummary.knownConclusions[0]);
});
test('whole-item filter rejects metacommentary, paths, secrets and process-exit claims', () => {
  const blocked = ['用户取消问题，暂无其他事项。', '问题已取消。', '用户明确要求停止当前任务。',
    '无需用户再确认。', '本人不需要补充信息。', '暂无待确认项。', 'Agent 已退出，因此项目完成。',
    '进程结束，代码已经运行完。', 'Session running', '4 个 Session 等待中', 'user canceled the question',
    '结果位于 /home/index/private/report.md', '见 src/index.mjs', '浏览 https://example.com/result',
    'token: example-only-secret', 'Bearer example-only-secret', 'API_KEY=example-only-secret', '请使用 `run()`',
    '<script>alert(1)</script>', '结果已经完成，但尚未…', '长'.repeat(61)];
  for (const value of blocked) assert.equal(usableSummaryText(value), null, value);
  assert.equal(usableSummaryText('离线动作对比已完成；能力是否提升，还要看独立评测。'), '离线动作对比已完成；能力是否提升，还要看独立评测。');
  assert.equal(selectObservation([session('noise', { activity: waiting, workSummary: { needsFromUser: blocked } })], options, now).kind, 'quiet');
});
test('dwell, source withdrawal and new waiting preemption', () => {
  const initial = advanceObservation([session()], options, null, now);
  const copy = JSON.stringify(initial.state);
  const stable = advanceObservation([session()], options, initial.state, now + 30_000);
  assert.equal(stable.observation.key, initial.observation.key);
  assert.equal(JSON.stringify(initial.state), copy, 'caller state is never mutated');
  assert.equal(advanceObservation([], options, initial.state, now + 1).observation.kind, 'quiet');
  assert.equal(advanceObservation([session(), session('ask', { activity: waiting })], options, initial.state, now + 1).observation.kind, 'attention');
});
test('unchanged summary does not become new when assistant timestamp advances', () => {
  const first = advanceObservation([session()], options, null, now);
  const same = session('one', { lastAssistantMessageAt: new Date(now + 60_000).toISOString() });
  assert.equal(advanceObservation([same], options, first.state, now + 60_000).observation.kind, 'quiet');
  const sentence = '更正：离线数据尚未核对完成，请提供独立评测结果。';
  const corrected = session('one', { workSummary: { knownConclusions: [sentence] } });
  assert.equal(advanceObservation([corrected], options, first.state, now + 60_000).observation.sentence, sentence);
});
test('pending attention repeats only after cooldown; results get a turn', () => {
  const data = [session(), session('ask', { activity: waiting })];
  const first = advanceObservation(data, options, null, now);
  const next = advanceObservation(data, options, first.state, now + 60_000);
  assert.equal(next.observation.kind, 'result');
  const after = advanceObservation(data, options, next.state, now + 120_000);
  assert.equal(after.observation.kind, 'quiet');
  assert.equal(advanceObservation(data, options, after.state, now + 30 * 60_000).observation.kind, 'attention');
});
test('rest starts after 90 minutes, holds 30 seconds, can be disabled, never claims activity', () => {
  const opts = { ...options };
  const first = advanceObservation([], opts, null, now);
  assert.equal(first.observation.kind, 'quiet');
  assert.equal(advanceObservation([], opts, first.state, now + 89 * 60_000).observation.kind, 'quiet');
  const due = advanceObservation([], opts, first.state, now + 90 * 60_000);
  assert.equal(due.observation.kind, 'rest');
  assert.equal(due.observation.observedAt, null);
  assert.doesNotMatch(due.observation.sentence, /久坐|已经|工作.*分钟/);
  assert.equal(advanceObservation([], opts, due.state, now + 90 * 60_000 + 29_000).observation.kind, 'rest');
  assert.equal(advanceObservation([], opts, due.state, now + 90 * 60_000 + 30_000).observation.kind, 'quiet');
  assert.equal(advanceObservation([], { ...options, restEnabled: false }, due.state, now + 90 * 60_000 + 1).observation.kind, 'quiet');
});
test('night rest is suppressed and state is isolated per Person; JSON round trip preserves dedupe', () => {
  const opts = { ...options, restEnabled: true };
  const night = Date.parse('2026-10-20T14:00:00Z');
  const first = advanceObservation([], opts, null, night - 90 * 60_000);
  assert.equal(advanceObservation([], opts, first.state, night).observation.kind, 'quiet');
  const seen = advanceObservation([session()], options, null, now);
  assert.equal(advanceObservation([session()], options, JSON.parse(JSON.stringify(seen.state)), now + 60_000).observation.kind, 'quiet');
  const separate = advanceObservation([session()], { ...options, personId: 'different' }, seen.state, now + 60_000);
  assert.equal(separate.observation.kind, 'result');
});
test('input order and duplicated source entries do not affect choice', () => {
  const data = [session('a'), session('b'), session('a')];
  assert.deepEqual(observationCandidates(data, options, now), observationCandidates(data.toReversed(), options, now));
});

test('actual low-value screen messages, generic capabilities and negated invitations stay quiet', () => {
  const noise = [
    '处理记录缺少证据、关联错误或损坏时不会误清空首页。',
    '原精选案例、人评、草稿和并发编辑成果得到保留；四项目页面及相关回归检查通过。',
    '未完成事项支持跨日追踪；支持分支并回原事项，避免重复计数。',
    '文字读取已有工作记录中的新结论与待确认事项，带具体时间并去重；未增加AI扫描。',
    '设备回执显示动画约10帧/秒；更新后的右侧人物布局已收到播放回执。',
    '报告已完成。', '功能支持下载和查看报告。', '现在不能查看报告。',
    '暂不需要你确认屏幕。', '如果报告完成，可以查看结果。',
    '等到上线后，你可以开始验收。', '无需提供额外信息。',
  ];
  for (const sentence of noise) for (const activity of [session().activity, waiting]) {
    const workSummary = { knownConclusions: [sentence], needsFromUser: [sentence] };
    assert.equal(selectObservation([session('noise', { workSummary, activity })], options, now).kind, 'quiet', sentence);
  }
});

test('concrete reader invitations keep wording and incomplete-result qualifications', () => {
  for (const sentence of ['真机弄好了，快去看看吧。', '新版已经部署，可以开始验收画面。',
    '请选择要安装的版本。', '录音尚未上传，请先连接网络。',
    '报告已生成，你可以查看结果。', '实机效果仍需本人确认。']) {
    const chosen = selectObservation([session('useful', { workSummary: { knownConclusions: [sentence] } })], options, now);
    assert.equal(chosen.sentence, sentence);
    assert.equal(chosen.kind, 'result');
  }
});

test('fresh results expire after 15 minutes while pending reader requests retain their own horizon', () => {
  const old = session('old', { lastAssistantMessageAt: new Date(now - 15 * 60_000).toISOString() });
  assert.equal(selectObservation([old], options, now).kind, 'quiet');
  assert.equal(selectObservation([{ ...old, activity: waiting }], options, now).kind, 'attention');
  const first = advanceObservation([session()], options, null, now);
  assert.equal(advanceObservation([old], options, first.state, now + 1).observation.kind, 'quiet');
});
