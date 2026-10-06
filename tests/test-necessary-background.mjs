import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-background-'));
setIsolatedTestHome(home);
const memoryDir = join(home, '.remotelab', 'memory');
await mkdir(join(memoryDir, 'reference', 'people'), { recursive: true });
const company = join(memoryDir, 'reference', 'company.md');
const profile = join(memoryDir, 'reference', 'people', 'person_zhang.md');
try {
  const { buildRelatedPersonContext, collectRelatedPeople, resolveSourcePerson } = await import('../chat/related-person-context.mjs');
  const { readNecessaryBackground, retrieveNecessaryContext, needsCompanyBackground } = await import('../chat/necessary-background.mjs');
  const { buildSourceContextPrompt } = await import('../chat/source-context-prompt.mjs');
  const auth = { people: [
    { id: 'person_wine', name: '酒嘉年', identities: [{ id: 'identity_wine', kind: 'feishu', realm: 'route', subjectId: 'ou_wine' }] },
    { id: 'person_zhang', name: '张思源', identities: [{ id: 'identity_zhang', kind: 'feishu', realm: 'route', subjectId: 'ou_zhang' }] },
  ] };
  const config = join(home, '.config', 'remotelab');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_wine', ...auth }));
  await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
  await writeFile(profile, '# 张思源\n\n## 称呼偏好\n提及本人时使用完整姓名张思源。\n\n## 写作偏好\n这条无关写作要求不该套到酒嘉年的项目上。');
  const sourceContext = { connector: 'feishu', sourceRouteId: 'route', conversationContext: { messages: [
    { sender: '旧昵称', text: '补充项目建议', messageId: 'm1', authorRef: { kind: 'feishu', subjectId: 'ou_zhang' } },
  ] } };
  const options = { personId: 'person_wine', identityId: 'identity_wine', sourceContext, authDocument: auth, memoryDir, query: '开工流程' };
  const people = collectRelatedPeople(options);
  assert.equal(people.find(person => person.personId === 'person_zhang').roles[0], 'referenced-person');
  const projected = await buildRelatedPersonContext(options);
  assert.match(projected, /完整姓名张思源/); assert.doesNotMatch(projected, /无关写作要求/);
  const rendered = buildSourceContextPrompt(sourceContext, 'test-request');
  assert.match(rendered, /张思源：补充项目建议/); assert.doesNotMatch(rendered, /旧昵称：/);
  assert.equal(resolveSourcePerson({ name: '张思源' }, sourceContext, auth), null);
  assert.equal(resolveSourcePerson({ subjectId: 'ou_zhang', kind: 'feishu', realm: 'wrong-route' }, sourceContext, auth), null);
  assert.match(await buildRelatedPersonContext({ ...options, maxChars: 5 }), /did not fit/);
  assert.doesNotMatch(await buildRelatedPersonContext({ ...options, sourceContext: {}, query: '修正 CSS' }), /完整姓名张思源/);
  assert.match(await buildRelatedPersonContext({ ...options, sourceContext: {}, query: '引用张思源的建议' }), /完整姓名张思源/);
  await writeFile(company, '# 公共背景\n办公室资料以本文件为准。\n\n## 已由用户提供\n办公地点：测试创新大厦。\n\n## 周边餐饮线索\n旧网页线索需要当次核验。');
  const started = performance.now();
  const restaurant = await readNecessaryBackground({}, { memoryDir, query: '公司附近吃点什么' });
  const found = restaurant.coverage.find(entry => entry.kind === 'company');
  assert.equal(found.result, 'found'); assert.match(found.excerpts.join('\n'), /测试创新大厦/);
  assert.equal(needsCompanyBackground('我们上班的地方附近有啥饭'), true);
  assert.equal(needsCompanyBackground('修复公司网站登录程序'), false);
  const unrelated = await readNecessaryBackground({}, { memoryDir, query: '修改 WebSocket 程序' });
  assert.equal(unrelated.coverage.find(entry => entry.kind === 'company').bodyLoaded, false);
  const tiny = await readNecessaryBackground({}, { memoryDir, query: '办公地点', maxChars: 5 });
  assert.equal(tiny.coverage.find(entry => entry.kind === 'company').result, 'partial');
  await writeFile(company, '# 公共背景\n\n## 已由用户提供\n更正：办公地点变为测试新大厦，旧地点撤销。');
  const changed = (await readNecessaryBackground({}, { memoryDir, query: '公司附近吃点什么' })).coverage.find(entry => entry.kind === 'company');
  assert.notEqual(changed.hash, found.hash); assert.match(changed.excerpts.join('\n'), /旧地点撤销/);
  await writeFile(profile, '<!-- remotelab-learning:start -->坏掉的档案');
  assert.match(await buildRelatedPersonContext(options), /Profile unavailable/);
  await writeFile(company, 'x'.repeat(32769));
  assert.equal((await readNecessaryBackground({}, { memoryDir, query: '办公地点' })).coverage.find(entry => entry.kind === 'company').status, 'too-large-or-not-file');
  await rm(company);
  assert.equal((await readNecessaryBackground({}, { memoryDir, query: '办公地点' })).coverage.find(entry => entry.kind === 'company').status, 'not-recorded');
  const result = await retrieveNecessaryContext({}, { ...options, query: '办公地点' });
  assert.match(result.context, /Retrieval coverage/); assert.match(result.context, /not-recorded/);
  await writeFile(join(memoryDir, 'learning-policy.json'), '{bad json');
  const brokenPolicy = await retrieveNecessaryContext({}, options);
  assert.equal(brokenPolicy.coverage[0].result, 'source-unavailable');
  await rm(join(memoryDir, 'learning-policy.json'));
  await writeFile(profile, '# 张思源\n\n## 称呼偏好\n引用时使用张思源。');
  await writeFile(company, '# 公共背景\n\n## 已由用户提供\n地点：测试大厦。');
  const { buildTurnContextHook } = await import('../chat/turn-context-hook.mjs');
  const timings = [];
  let companyChars = 0, codeChars = 0;
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const output = await buildTurnContextHook({ id: 'test' }, { personId: 'person_wine', identityId: 'identity_wine',
      sourceContext, query: i % 2 ? '修正程序错误' : '公司附近吃什么' });
    timings.push(performance.now() - start);
    if (i % 2) codeChars = output.length; else companyChars = output.length;
    if (i % 2) assert.doesNotMatch(output, /地点：测试大厦/); else assert.match(output, /地点：测试大厦/);
    assert.match(output, /引用时使用张思源/);
  }
  console.log(JSON.stringify({ measurement: 'isolated full hook; no model invoked', samples: timings.length,
    p50Ms: timings.sort((a, b) => a - b)[10], p95Ms: timings[18], companyChars, codeChars }));
  console.log('BACKGROUND_VERIFIED: mixed author identity and naming scope; new mentions; unknown author rejected; original company source; normal-language relevance; no unrelated body; version changes; corrupt/missing/oversized/budget coverage. Elapsed ms=' + Math.round(performance.now() - started));
} finally { await rm(home, { recursive: true, force: true }); }
