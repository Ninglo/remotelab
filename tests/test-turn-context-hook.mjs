#!/usr/bin/env node
import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { syncBuiltinESMExports } from 'node:module';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-turn-hook-'));
setIsolatedTestHome(tempHome);

const { buildTurnContextHook } = await import('../chat/turn-context-hook.mjs');

const hook = await buildTurnContextHook({
  activeAgreements: [
    '默认自然段表达。',
    '默认自然段表达。',
  ],
  workSummary: {
    mode: 'project',
    summary: '先消化用户给的材料，再推进下一步。',
    rawMaterials: ['sales.xlsx'],
    reusablePatterns: ['先接住具体材料，再决定是否把经验抽象成通用规则。'],
    nextSteps: ['检查结构'],
  },
});

assert.doesNotMatch(hook, /RemoteLab context pointers|writeback-targets|session-spawn/);
assert.match(hook, /active working agreements/);
assert.match(hook, /默认自然段表达。/);
assert.equal(await buildTurnContextHook({}), '', 'an ordinary resumed turn should not replay startup context');
assert.doesNotMatch(hook, /Current provider-neutral work summary/);
assert.doesNotMatch(hook, /Reusable patterns/);
assert.doesNotMatch(hook, /sales\.xlsx/);

assert.doesNotMatch(hook, /standing authorization/);
assert.doesNotMatch(hook, /Prefer RemoteLab-side execution/);
assert.doesNotMatch(hook, /brief self-review/);
assert.doesNotMatch(hook, /split into child sessions/);

const logHook = await buildTurnContextHook({}, { sourceContext: {
  connector: 'feishu', chatId: 'test-chat', feishuLog: { sessionId: 'session123', runId: 'run_prior' },
} });
assert.match(logHook, /Target Session: session123\. Prior Run: run_prior/);
assert.match(logHook, /langsmith\?format=json&runId=run_prior/);
assert.match(logHook, /read-only GET/);
assert.doesNotMatch(await buildTurnContextHook({}, { sourceContext: { connector: 'feishu' } }), /Prior Run/);

// Reproduce a noisy bound-comment query with every old background source
// populated. Ordinary turns must remain independent of those bodies; explicit
// work/memory retrieval is covered by their own integration suites.
const { MEMORY_DIR, CONFIG_DIR, AUTH_FILE } = await import('../lib/config.mjs');
const { loadAuthDocument } = await import('../lib/auth-config.mjs');
await fs.mkdir(path.join(MEMORY_DIR, 'reference', 'people'), { recursive: true });
await fs.mkdir(CONFIG_DIR, { recursive: true });
await fs.writeFile(AUTH_FILE, JSON.stringify({ version: 2, people: [{ id: 'person_current', name: 'Current Person',
  identities: [{ id: 'identity_current', kind: 'feishu', realm: 'fixture-route', subjectId: 'fixture-sender' }] }] }));
await loadAuthDocument({ persistMigration: false });
await fs.writeFile(path.join(MEMORY_DIR, 'reference', 'people', 'person_current.md'),
  '# Current Person\n\n## 称呼偏好\nUNRELATED_PERSON_BODY 文档评论回复。');
await fs.writeFile(path.join(MEMORY_DIR, 'reference', 'agent-handbook.md'), 'UNRELATED_HANDBOOK_BODY 文档评论回复。');
await fs.writeFile(path.join(MEMORY_DIR, 'reference', 'company.md'), '# 公司\n\n## 地点\nUNRELATED_COMPANY_BODY。');
await fs.writeFile(path.join(MEMORY_DIR, 'skills.md'), '- 文档评论回复：UNRELATED_SKILL_BODY');
await fs.writeFile(path.join(MEMORY_DIR, 'projects.md'), '# 文档评论回复\n\nUNRELATED_PROJECT_BODY 恢复模型副本。');
await fs.writeFile(path.join(MEMORY_DIR, 'learning-policy.json'), JSON.stringify({ version: 1, enabled: true,
  profiles: true, handbook: true, context: true, personIds: ['person_current'] }));
await fs.writeFile(path.join(CONFIG_DIR, 'chat-sessions.json'), JSON.stringify([
  { id: 'current', name: 'Current work' },
  { id: 'other', name: '文档评论回复', workSummary: { goal: '文档评论回复与恢复模型副本',
    summary: 'UNRELATED_WORK_RESULT', rawMaterials: ['UNRELATED_WORK_ARTIFACT'] } },
]));
await fs.writeFile(path.join(CONFIG_DIR, 'service-access.json'), JSON.stringify({ version: 1, units: ['fixture.service'] }));
const projectConfig = { schemaVersion: 1, enabled: true, contextEnabled: true, reviewEnabled: true, releaseId: 'fixture',
  indexPath: path.join(MEMORY_DIR, 'projects.md'), ledgerPath: path.join(MEMORY_DIR, 'projects.md'),
  workflowPath: path.join(MEMORY_DIR, 'workflow.md'), projects: [{ id: 'example' }],
  groups: [{ sourceRouteId: 'fixture-route', chatId: 'fixture-chat', projectIds: ['example'] }], sessionBindings: [] };
await fs.writeFile(path.join(MEMORY_DIR, 'project-runtime.json'), JSON.stringify(projectConfig));
const contextOptions = { personId: 'person_current', identityId: 'identity_current', sourceContext: {
  connector: 'feishu', sourceRouteId: 'fixture-route', chatId: 'fixture-chat',
  conversationKind: 'document_comment', documentBinding: true, sender: { identityId: 'identity_current' },
} };
const ordinary = await buildTurnContextHook({ id: 'current' }, contextOptions);
const reads = [], originalOpen = fs.open, originalReadFile = fs.readFile;
try {
  fs.open = async (file, ...args) => { reads.push(String(file)); return originalOpen(file, ...args); };
  fs.readFile = async (file, ...args) => { reads.push(String(file)); return originalReadFile(file, ...args); };
  syncBuiltinESMExports();
  for (const query of ['收到已绑定文档的一条新评论。评论完整历史：本轮回复并恢复模型副本，部署到公司。', '继续吧', '引用 Current Person 的建议']) {
    assert.equal(await buildTurnContextHook({ id: 'current' }, { ...contextOptions, query }), ordinary,
      'wrapper words and arbitrary task text must not trigger automatic background reads');
  }
} finally {
  fs.open = originalOpen;
  fs.readFile = originalReadFile;
  syncBuiltinESMExports();
}
assert.ok(reads.some(file => file.endsWith('/project-runtime.json')), 'read instrumentation observes the retained pointer configuration');
assert.ok(!reads.some(file => /\/(skills\.md|projects\.md|company\.md|agent-handbook\.md|person_current\.md|learning-policy\.json|service-access\.json|chat-sessions\.json)$/.test(file)),
  `ordinary context unexpectedly read background: ${reads.join(', ')}`);
assert.match(ordinary, /Person memory pointer/);
assert.match(ordinary, /Project memory pointers/);
assert.match(ordinary, /"projectIds":\["example"\]/);
assert.doesNotMatch(ordinary, /UNRELATED_|Work awareness|Necessary background|Deferred person context|Scoped collaboration memory|service-access/);
assert.ok(ordinary.length < 2000, `pointer-only fixture grew to ${ordinary.length} characters`);
// Bad background data must not become new prompt diagnostics on ordinary work.
await fs.writeFile(path.join(MEMORY_DIR, 'learning-policy.json'), '{broken');
await fs.writeFile(path.join(MEMORY_DIR, 'reference', 'people', 'person_current.md'), '<!-- remotelab-learning:start -->broken');
assert.equal(await buildTurnContextHook({ id: 'current' }, contextOptions), ordinary);
console.log(JSON.stringify({ measurement: 'ordinary bound-comment hook with populated background stores', chars: ordinary.length }));
await fs.rm(tempHome, { recursive: true, force: true });
console.log('test-turn-context-hook: ok');
