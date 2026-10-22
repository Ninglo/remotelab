import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parse as parseUrl } from 'node:url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-delivery-review-'));
setIsolatedTestHome(home);
try {
  const { updateAuthDocument } = await import('../lib/auth-config.mjs');
  await updateAuthDocument(d => {
    d.people = ['a', 'b'].map(n => ({ id: `person_${n}`, name: n, handle: n, credentials: [],
      identities: ['web', 'feishu'].map(kind => ({ id: `${kind}_${n}`, kind, realm: 'fixture', subjectId: n })) }));
    d.primaryPersonId = 'person_a';
  });
  const { loadPersonMessageReplies, changePersonMessageReplies } = await import('../chat/person-message-replies.mjs');
  const { resolveMessageReplyPolicy } = await import('../chat/message-reply-settings.mjs');
  const { captureDeliverySelfReview, deliverySelfReviewPrompt, captureGroupDeliverySelfReviewPolicy } = await import('../chat/delivery-self-review.mjs');
  const { buildPrompt } = await import('../chat/session-manager.mjs');
  const { handleMessageReplySettings } = await import('../chat/router-message-reply-settings.mjs');
  const { requests } = await import('../chat/requests.mjs');
  const { runMessageReplyCommand } = await import('../lib/message-reply-command.mjs');
  const a = { personId: 'person_a', identityId: 'web_a' }, b = { personId: 'person_b', identityId: 'web_b' };
  const options = { usageSurface: 'web', viewPersonId: a.personId, initiatedByIdentityId: a.identityId };
  const before = await loadPersonMessageReplies(a), other = await loadPersonMessageReplies(b);
  assert.equal(before.choices.selfReview, false);
  assert.equal(before.active, null);
  assert.equal(await resolveMessageReplyPolicy(options), null);
  let reads = 0;
  const readAsset = async () => { reads++; return 'frozen-review'; };
  for (const policy of [null, { scope: 'person', personId: a.personId }, { selfReview: true, scope: 'group' }]) {
    assert.equal(await captureDeliverySelfReview(policy, a, { readAsset }), undefined);
  }
  assert.equal(reads, 0, 'default/off performs no review rule read');
  const rec = (await requests.accept({ sessionId: 'review', requestId: 'human', text: '开启交付前自检', options })).record;
  async function call(url, body, authSession = { authKind: 'service' }) {
    const parsedUrl = parseUrl(url, true), req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = body ? 'POST' : 'GET';
    let value;
    assert(await handleMessageReplySettings({ req, res: {}, pathname: parsedUrl.pathname, parsedUrl, authSession,
      writeJson: (_res, status, json) => { value = { status, json }; } }));
    return value;
  }
  let output;
  const io = { runId: rec.runId, stdout: { write: text => { output = text; } }, client: { request: async (url, opts) => {
    const { status, json } = await call(url, opts?.body); return { response: { ok: status === 200 }, json };
  } } };
  await runMessageReplyCommand(['self-review', 'on', '--json'], io);
  const enabled = JSON.parse(output).settings;
  assert.equal(enabled.choices.selfReview, true);
  assert.deepEqual(enabled.choices, { ...before.choices, selfReview: true });
  assert.deepEqual(await loadPersonMessageReplies(b), other);
  const policy = await resolveMessageReplyPolicy(options);
  assert.equal(policy.deliverySelfReview.status, 'captured');
  for (const chatType of ['p2p', 'group']) {
    const p = await resolveMessageReplyPolicy({ viewPersonId: a.personId, initiatedByIdentityId: 'feishu_a', feishuConnectorAuthenticated: true,
      sourceContext: { connector: 'feishu', sourceRouteId: 'fixture', chatId: 'oc_a', chatType, messageId: 'om_a', sender: { openId: 'a', senderType: 'user' } },
      sourceDelivery: { connector: 'feishu', sourceRouteId: 'fixture', target: { chatId: 'oc_a', conversationKind: 'thread' } } });
    assert.equal(p.deliverySelfReview.sha256, policy.deliverySelfReview.sha256);
  }
  for (const extra of [{ internalOperation: true }, { automationTitle: 'timer' }, { initiatedByIdentityId: 'web_b' }]) {
    assert.equal(await resolveMessageReplyPolicy({ ...options, ...extra }), null);
  }
  assert.match(deliverySelfReviewPrompt(policy, b), /OFF/);
  assert.match(deliverySelfReviewPrompt(policy, { ...a, identityId: 'web_b' }), /OFF/);
  const captured = await captureDeliverySelfReview(policy, a, { readAsset });
  assert.equal(reads, 1);
  assert.match(deliverySelfReviewPrompt({ ...policy, deliverySelfReview: captured }, a), /frozen-review/);
  assert.doesNotMatch(deliverySelfReviewPrompt({ ...policy, deliverySelfReview: { ...captured, content: 'changed' } }, a), /changed/);
  assert.match(deliverySelfReviewPrompt({ ...policy, deliverySelfReview: undefined }, a), /unavailable/);
  for (const tool of ['codex', 'claude', 'pi']) {
    const prompt = await buildPrompt('review', { id: 'review', systemPrompt: '', codexThreadId: 'resumed' }, '完成原交办', tool, tool, null,
      { ...options, messageReplyPolicy: policy });
    assert.match(prompt, /交付前自检 v1/);
    assert.match(prompt, /attachment_delivery/);
    assert.match(prompt, /假数据/);
    assert.match(prompt, /验收条件/);
  }
  // Older UI clients preserve an opt-in they cannot render.
  const oldUI = await changePersonMessageReplies({ action: 'apply', expectedRevision: enabled.revision, confirm: true,
    choices: { opening: false, checklist: false, progress: 'none' } }, a);
  assert.equal(oldUI.active.selfReview, true);
  const endpoint = '/api/message-reply-settings/current-run';
  const payload = { setting: 'self-review', runId: rec.runId, enabled: false, expectedRevision: oldUI.revision, confirm: true };
  assert.equal((await call(endpoint, { ...payload, personId: b.personId })).status, 400);
  assert.equal((await call(endpoint, payload, { personId: b.personId })).status, 403);
  assert.equal((await call(endpoint, { ...payload, confirm: false })).status, 400);
  assert.equal((await call(endpoint, { ...payload, expectedRevision: 0 })).status, 409);
  await runMessageReplyCommand(['self-review', 'off', '--json'], io);
  assert.equal(JSON.parse(output).settings.choices.selfReview, false);
  assert.equal(policy.selfReview, true, 'accepted snapshot is unchanged');
  const off = await resolveMessageReplyPolicy(options);
  assert.equal(off.deliverySelfReview, undefined);
  assert.match(deliverySelfReviewPrompt(off, a), /OFF/);
  const prompt = await buildPrompt('review', { id: 'review', systemPrompt: '', codexThreadId: 'resumed' }, '新工作', 'codex', 'codex', null,
    { ...options, messageReplyPolicy: off });
  assert.doesNotMatch(prompt, /交付前自检 v1/);
  assert.match(prompt, /Optional delivery self-review is OFF/);
  const { projectRuleContext } = await import('../chat/rule-context.mjs');
  const scope = { enabled: true, identity: { field: 'codexThreadId', id: 'native' }, recovery: 'codex-session-start', requestId: 'next', personId: a.personId, identityId: a.identityId };
  const slots = p => [{ id: 'delivery_self_review', content: deliverySelfReviewPrompt(p, a) }];
  const deps = { head: async () => 1, history: async () => [], snapshot: async () => {} };
  const first = await projectRuleContext('review', slots(policy), scope, deps);
  const prev = { ...deps, history: async () => [{ type: 'message', role: 'user', requestId: 'previous' }],
    request: async () => ({ runId: 'previous', nativeReceipt: { accepted: true } }),
    run: async () => ({ id: 'previous', sessionId: 'review', codexThreadId: 'native' }),
    manifest: async () => ({ ruleContextDelivery: first.receipt }) };
  assert.equal((await projectRuleContext('review', slots(policy), scope, prev)).receipt.mode, 'reference');
  const disabled = await projectRuleContext('review', slots(off), scope, prev);
  assert.deepEqual(disabled.receipt.changedIds, ['delivery_self_review']);
  assert.match(disabled.slots.find(s => s.id === 'delivery_self_review').content, /OFF/);
  const groupInput = { viewPersonId: a.personId, initiatedByIdentityId: a.identityId, feishuConnectorAuthenticated: true,
    sourceContext: { connector: 'feishu', sourceRouteId: 'bot-a', tenantKey: 'tenant-a', chatType: 'group', chatId: 'oc_a',
      messageId: 'om_a', sender: { openId: 'a', senderType: 'user' }, groupSelfReview: { enabled: true, revision: 1 } },
    sourceDelivery: { connector: 'feishu', sourceRouteId: 'bot-a', target: { tenantKey: 'tenant-a', chatId: 'oc_a' } } };
  const group = await captureGroupDeliverySelfReviewPolicy(groupInput, off);
  assert.equal(group.scope, 'group');
  assert.equal(group.deliverySelfReview.status, 'captured');
  assert.equal((await loadPersonMessageReplies(a)).choices.selfReview, false, 'group opt-in does not mutate personal choices');
  assert.equal(await captureGroupDeliverySelfReviewPolicy(groupInput, policy), null, 'both enabled still use one personal review');
  const groupContext = { ...groupInput, ...a };
  assert.match(deliverySelfReviewPrompt(group, groupContext), /Enabled by this Feishu group/);
  assert.match(await buildPrompt('review', { id: 'review', systemPrompt: '' }, '交付', 'codex', 'codex', null,
    { ...groupInput, groupDeliverySelfReviewPolicy: group }), /交付前自检 v1/);
  const otherGroupInput = { ...groupInput, viewPersonId: b.personId, initiatedByIdentityId: b.identityId };
  assert.equal((await captureGroupDeliverySelfReviewPolicy(otherGroupInput, null)).personId, b.personId);
  assert.match(deliverySelfReviewPrompt(group, { ...groupInput, ...b }), /OFF/, 'a saved receipt cannot impersonate another sender');
  for (const mutate of [
    x => { x.feishuConnectorAuthenticated = false; }, x => { x.sourceContext.chatType = 'p2p'; },
    x => { x.sourceContext.sender.senderType = 'bot'; }, x => { x.automationTitle = 'timer'; },
    x => { x.sourceDelivery.sourceRouteId = 'bot-b'; }, x => { x.sourceDelivery.target.tenantKey = 'tenant-b'; },
    x => { x.sourceDelivery.target.chatId = 'oc_b'; }, x => { x.initiatedByIdentityId = b.identityId; },
    x => { x.sourceContext.groupSelfReview.enabled = false; }, x => { delete x.sourceContext.groupSelfReview; },
  ]) {
    const invalid = structuredClone(groupInput); mutate(invalid);
    assert.equal(await captureGroupDeliverySelfReviewPolicy(invalid, off), null);
  }
  for (const key of ['chatId', 'tenantKey', 'sourceRouteId']) {
    const moved = structuredClone(groupContext);
    moved.sourceContext[key] = 'other';
    if (key === 'sourceRouteId') moved.sourceDelivery[key] = 'other'; else moved.sourceDelivery.target[key] = 'other';
    assert.match(deliverySelfReviewPrompt(group, moved), /OFF/, 'group receipt cannot leave its address');
  }
  const afterGroupOff = structuredClone(groupInput); delete afterGroupOff.sourceContext.groupSelfReview;
  assert.deepEqual(await captureGroupDeliverySelfReviewPolicy(afterGroupOff, off,
    { options: { groupDeliverySelfReviewPolicy: group } }), group, 'ongoing work preserves group activation');
  assert.equal(await captureGroupDeliverySelfReviewPolicy(groupInput, off, { options: {} }), null, 'ongoing off work does not inherit later activation');
  assert.equal(await captureGroupDeliverySelfReviewPolicy(afterGroupOff, off), null, 'new work reads group off');
  // Preserve the June 15 attachment-only regression with a real stored file,
  // a mirrored result event and the same visible projection used by the API.
  const { publishLocalFileAssetFromPath } = await import('../chat/file-assets.mjs');
  const { buildSessionDisplayEvents } = await import('../chat/session-display-events.mjs');
  const { buildReplyPublicationPayload } = await import('../chat/reply-publication.mjs');
  const file = join(home, 'report.csv');
  await writeFile(file, 'name,value\nactual,42\n');
  const asset = await publishLocalFileAssetFromPath({ sessionId: 'review', localPath: file });
  const history = [{ type: 'message', role: 'user', seq: 1, runId: 'run_original', content: '交付CSV' },
    { type: 'message', role: 'assistant', seq: 2, source: 'result_file_assets', resultRunId: 'run_original',
      content: '', attachments: [{ assetId: asset.id, originalName: 'report.csv', sizeBytes: asset.sizeBytes, downloadUrl: asset.downloadUrl, renderAs: 'file' }] }];
  const visible = buildSessionDisplayEvents(history, { sessionRunning: false });
  const attachment = visible.find(e => e.type === 'attachment_delivery');
  assert.equal(attachment.attachments[0].assetId, asset.id);
  assert.equal(attachment.attachments[0].sizeBytes, Buffer.byteLength(await readFile(file)));
  const reply = buildReplyPublicationPayload(history, { id: 'run_original' }, { includeSessionEntry: false });
  assert.equal(reply.attachments[0].assetId, asset.id, 'attachment-only output reaches connector publication');
  console.log('PASS delivery self-review: default off, explicit settings/identity isolation, frozen rules, all Harness prompts, disable and real attachment projection');
} finally { await rm(home, { recursive: true, force: true }); }
