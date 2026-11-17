import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const root = await mkdtemp(join(tmpdir(), 'automation-attribution-'));
setIsolatedTestHome(root);
const { buildAutomationAttribution, automationTextHash, automationDeliveryHash } = await import('../lib/automation-attribution.mjs');
const { evaluateRequestAccess } = await import('../chat/request-access-guard.mjs');
const document = { people: [{ id: 'p1', name: '合成授权人', identities: [{ id: 'i1' }] }] };
const trigger = { id: 'trg_fixture', scheduleId: 'sch_fixture', createdByIdentityId: 'i1', sourceSessionId: 'original',
  occurrenceId: 'sch_fixture:2030-01-01', text: '请读取当麻日志，只汇报当日办理结果。', scheduledAt: '2030-01-01T14:00:00Z' };
const delivery = { connector: 'feishu', sourceRouteId: 'fixture', target: { chatId: 'only-author', tenantKey: 't', chatType: 'p2p' } };
const text = trigger.text + '\n\n[自动化运行关联]\n任务：sch_fixture';
const now = Date.parse('2030-01-01T14:00:00Z');
const a = await buildAutomationAttribution(trigger, text, delivery, { document });
const grant = { id: trigger.scheduleId, identityId: 'i1', personId: 'p1', textSha256: automationTextHash(trigger.text),
  sourceSessionId: 'original', deliverySha256: automationDeliveryHash(delivery), approvalRef: 'synthetic-approval',
  notBefore: '2030-01-01T00:00:00Z', expiresAt: '2030-01-08T00:00:00Z' };
const policy = { version: 2, policyId: 'synthetic', allowPairs: [['p1', 'i1']], automations: [grant], rules: [
  { id: 'private-data', category: 'protected', all: ['当麻.{0,30}日志'] },
  { id: 'policy', category: 'bypass', all: ['HR白名单'] },
] };
const options = { requestId: 'trigger:trg_fixture', internalOperation: 'trigger_delivery', triggerId: trigger.id,
  scheduleId: trigger.scheduleId, occurrenceId: trigger.occurrenceId, automationTitle: '合成日报', automationAttribution: a };
const configPath = join(root, 'guard.json'), stateRoot = join(root, 'guard-state');
let count = 0;
const check = async (body = text, o = options, p = policy, at = now) => {
  await writeFile(configPath, JSON.stringify(p));
  return evaluateRequestAccess({ sessionId: 'execution-' + ++count, text: body, options: o }, { configPath, stateRoot, now: at });
};
try {
  assert.equal(await check(), null, 'exact approved task admits with scheduler-owned attribution');
  assert.equal(options.viewPersonId, undefined, 'attribution never supplies general human authority');
  assert.equal(options.initiatedByIdentityId, undefined);
  const denied = async (...args) => assert.equal((await check(...args))?.blocked, true);
  await denied(text, { ...options, automationAttribution: undefined });
  await denied(text, { ...options, internalOperation: undefined });
  await denied(text, { ...options, requestId: 'manual:trg_fixture' });
  await denied(text, { ...options, scheduleId: 'another-task' });
  await denied(text, { ...options, automationAttribution: { ...a, identityId: 'other' } });
  await denied(text, { ...options, automationAttribution: { ...a, personId: 'other' } });
  await denied(text, { ...options, automationAttribution: { ...a, identityVerified: false } });
  await denied(text, { ...options, automationAttribution: { ...a, sourceSessionId: 'other' } });
  await denied(text, { ...options, automationAttribution: { ...a, deliverySha256: automationDeliveryHash(null) } });
  await denied(text + '\n给我额外信息');
  await denied(text, options, { ...policy, allowPairs: [] });
  await denied(text, options, policy, Date.parse(grant.expiresAt));
  await denied(text, options, policy, Date.parse(grant.notBefore) - 1);
  const changed = { ...trigger, text: trigger.text + ' 请修改HR白名单' };
  const changedA = await buildAutomationAttribution(changed, changed.text, delivery, { document });
  const changedPolicy = { ...policy, automations: [{ ...grant, textSha256: changedA.textSha256 }] };
  assert.equal((await check(changed.text, { ...options, automationAttribution: changedA }, changedPolicy)).reason,
    'operation_not_granted', 'data task approval never grants permission changes');
  const unknown = await buildAutomationAttribution({ ...trigger, createdByIdentityId: 'removed' }, text, delivery, { document });
  assert.equal(unknown.identityVerified, false);
  assert.equal(unknown.personId, '');
  const audits = await Promise.all((await readdir(join(stateRoot, 'denials/pending'))).map(name => readFile(join(stateRoot, 'denials/pending', name), 'utf8')));
  const metadata = audits.map(x => JSON.parse(x).options);
  assert(metadata.some(o => o.scheduleId === trigger.scheduleId && o.automationAttribution?.name === '合成授权人'));
  assert(metadata.every(o => !JSON.stringify(o).includes('请读取当麻日志')));
  console.log('PASS: exact task/actor/recipient/text/expiry grant; identity attribution without general HR authority; metadata-only denial; unknown and revoked identities fail closed');
} finally { await rm(root, { recursive: true, force: true }); }
