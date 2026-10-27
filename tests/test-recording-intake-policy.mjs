import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRecordingIntakePolicy } from '../lib/recording/intake-policy.mjs';
import { writeDurableJson } from '../lib/durable-records.mjs';

const root = await mkdtemp(join(tmpdir(), 'recording-intake-'));
const policyPath = join(root, 'policy.json');
const payload = { requestId: 'recording:machine:clip', text: 'Old automatic analysis template',
  sourceContext: { connector: 'recording', machineId: 'machine', recordingId: 'clip' },
  attachments: [{ assetId: 'original' }] };
const session = { conversation: { connector: 'feishu', sourceRouteId: 'route', target: { chatId: 'oc_group' } } };
const policy = { enabled: true, rules: [{ mode: 'transcribe_archive', sourceRouteId: 'route',
  chatId: 'oc_group', authorizationRefs: ['human:request'] }] };
const apply = (p = payload, s = session) => applyRecordingIntakePolicy(p, s, { policyPath });
try {
  assert.equal(await apply(), payload, 'absent policy preserves old clients');
  await writeDurableJson(policyPath, policy);
  const result = await apply();
  assert.match(result.text, /只完成转写和归档/);
  assert.match(result.text, /analysis 保持 pending/);
  assert.equal(result.sourceContext.captureRequestText, payload.text, 'capture template remains original evidence');
  assert.equal(result.attachments, payload.attachments, 'original audio references unchanged');
  assert.equal(result.sourceContext.recordingProcessing.mode, 'transcribe_archive');
  await writeDurableJson(policyPath, { ...policy, rules: [{ ...policy.rules[0], mode: 'analyze' }] });
  const analyzed = await apply();
  assert.equal(analyzed.sourceContext.recordingProcessing.mode, 'analyze');
  assert.match(analyzed.text, /基础分析和知识归档/);
  assert.doesNotMatch(analyzed.text, /analysis 保持 pending/);
  assert.equal(analyzed.sourceContext.captureRequestText, payload.text);
  assert.equal(analyzed.attachments, payload.attachments);
  const admittedArchive = { text: result.text, options: { sourceContext: result.sourceContext } };
  assert.deepEqual(await applyRecordingIntakePolicy(payload, session, { policyPath, priorRequest: admittedArchive }), result,
    'an analysis policy does not reprocess an already admitted archival request');
  assert.equal((await apply({ ...payload, requestId: 'human:analyze', text: 'Please analyze this recording' })).text,
    'Please analyze this recording', 'human follow-up is not suppressed');
  assert.equal((await apply({ ...payload, nativeQuestionId: 'question' })).text, payload.text);
  assert.equal((await apply(payload, { conversation: { ...session.conversation, sourceRouteId: 'other' } })).text, payload.text);
  assert.equal((await apply(payload, { conversation: { ...session.conversation, target: { chatId: 'oc_other' } } })).text, payload.text);
  assert.equal((await apply({ ...payload, sourceDelivery: session.conversation }, {})).text, payload.text,
    'caller-supplied delivery alone does not establish the destination');
  await writeDurableJson(policyPath, { ...policy, enabled: false });
  assert.equal(await apply(), payload);
  const priorRequest = { text: result.text, options: { sourceContext: result.sourceContext } };
  const replay = await applyRecordingIntakePolicy(payload, session, { policyPath, priorRequest });
  assert.equal(replay.text, result.text, 'lost receipt recovery retains the admitted mode after policy changes');
  const changed = { ...payload, text: 'different work' };
  assert.equal(await applyRecordingIntakePolicy(changed, session, { policyPath, priorRequest }), changed,
    'changed content is not concealed from the request fingerprint');
  assert.equal(await applyRecordingIntakePolicy(payload, session, { policyPath,
    priorRequest: { text: payload.text, options: { sourceContext: payload.sourceContext } } }), payload,
    'already accepted legacy requests are not rewritten');
  await writeDurableJson(policyPath, { ...policy, rules: [{ ...policy.rules[0], authorizationRefs: [] }] });
  assert.equal(await apply(), payload);
  console.log('recording intake policy: exact bound destination, automatic request identity, originals, opt-in and human follow-ups passed');
} finally { await rm(root, { recursive: true, force: true }); }
