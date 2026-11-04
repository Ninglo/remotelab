import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feishu-role-delivery-'));
setIsolatedTestHome(home);
const { recordRoleDeliveryContext, authorizeRoleDelivery } = await import('../connectors/feishu/delivery-access.mjs');
const { INTERVIEW_QUERY_UNAVAILABLE } = await import('../connectors/feishu/restricted-access.mjs');
const { processSourceDeliveryOnce } = await import('../scripts/feishu-connector.mjs');
const { enqueueSourceDelivery, claimSourceDelivery, completeSourceDelivery, failSourceDelivery,
  resolveSourceDelivery, getSourceDelivery } = await import('../chat/source-deliveries.mjs');
const policy = { mode: 'roles', roles: { appId: 'cli_test', tenantKey: 'tenant',
  hrOpenIds: ['ou_hr'], collaboratorOpenIds: ['ou_collaborator'], interviewerOpenIds: ['ou_ge'] } };
const config = { accessPolicy: policy, appId: 'cli_test', sourceRouteId: 'test', storageDir: join(home, 'connector') };
const event = { appId: 'cli_test', tenantKey: 'tenant', chatId: 'oc_ge', chatType: 'p2p',
  messageId: 'om_ge', messageType: 'post', eventType: 'im.message.receive_v1', messageText: '4. 提问 Alice | 下一轮应追问什么？',
  sender: { openId: 'ou_ge', senderType: 'user', tenantKey: 'tenant' } };
const sourceDelivery = target => ({ connector: 'feishu', sourceRouteId: 'test', target });
const runtime = () => ({ config });
const requestRemoteLab = async (path, { body }) => {
  try {
    if (path.endsWith('/claim')) return { response: { ok: true }, json: { claim: await claimSourceDelivery(body) } };
    const [, id, action] = /source-deliveries\/([^/]+)\/(complete|fail|resolve)/.exec(path);
    // Deliberately enforce the legacy core's stricter resolve contract.
    if (action === 'resolve') assert.ok(['unknown', 'delivery_failed'].includes((await getSourceDelivery(id)).state));
    const delivery = action === 'complete' ? await completeSourceDelivery(id, body.leaseId, body)
      : action === 'fail' ? await failSourceDelivery(id, body.leaseId, body.error, body) : await resolveSourceDelivery(id, body);
    return { response: { ok: true }, json: { delivery } };
  } catch (error) { throw new Error(`${path}: ${error.message}`); }
};
let sends = 0, queries = 0;
const helpers = { requestRemoteLab, enrichSummaryWithChatMetadata: async (r, s) => s,
  queryRestrictedInterview: async (p, s) => { queries++; assert.deepEqual(s, event); return 'fresh authorized result'; },
  sendFeishuText: async (r, s, text) => { sends++; assert.equal(s.chatId, 'oc_ge');
    assert.equal(text, 'fresh authorized result'); return { message_id: 'om_reply' }; } };
try {
  await recordRoleDeliveryContext(runtime(), event, { responseId: 'feishu:om_ge' });
  const queued = await enqueueSourceDelivery({ responseId: 'feishu:om_ge', text: 'STALE HR SECRET', sourceDelivery: sourceDelivery(event) });
  assert.equal(queued.sessionId, 'outbound');
  assert.equal(queued.target.sender, undefined, 'real outbox strips provider identity');
  assert.equal(queued.target.messageText, undefined, 'real outbox strips query text');
  // New runtime proves the identity survives process restart independently of outbox fields.
  await processSourceDeliveryOnce(runtime(), helpers);
  assert.equal((await getSourceDelivery(queued.id)).state, 'delivered');
  assert.equal(sends, 1); assert.equal(queries, 1);
  for (const changed of [ { ...queued, sessionId: 'hr-session' },
    { ...queued, sourceRouteId: 'other' }, { ...queued, target: { ...queued.target, chatId: 'oc_other' } },
    { ...queued, attachment: { path: 'secret' } }, { ...queued, kind: 'delivery_notice' } ]) {
    assert.equal(await authorizeRoleDelivery(runtime(), changed), null);
  }
  assert.equal(await authorizeRoleDelivery({ config: { ...config,
    accessPolicy: { mode: 'roles', roles: { ...policy.roles, interviewerOpenIds: [] } } } }, queued), null);
  await assert.rejects(recordRoleDeliveryContext(runtime(), { ...event, messageText: 'forged' }, { responseId: 'feishu:om_ge' }));
  const forged = await enqueueSourceDelivery({ responseId: 'forged', text: 'HR_SECRET',
    sourceDelivery: sourceDelivery({ ...event, restrictedInterview: true, sender: { ...event.sender, openId: 'ou_hr' } }) });
  await processSourceDeliveryOnce(runtime(), helpers);
  assert.equal((await getSourceDelivery(forged.id)).state, 'cancelled'); assert.equal(sends, 1);
  const hr = { ...event, messageId: 'om_hr', chatId: 'oc_hr', sender: { ...event.sender, openId: 'ou_hr' } };
  await recordRoleDeliveryContext(runtime(), hr, { responseId: 'feishu:om_hr', sessionId: 'hr-session' });
  const hrReply = await enqueueSourceDelivery({ responseId: 'feishu:om_hr', sessionId: 'hr-session',
    text: 'HR authorized answer', sourceDelivery: sourceDelivery(hr) });
  await processSourceDeliveryOnce(runtime(), { ...helpers, sendFeishuText: async (r, s, text) => {
    assert.equal(s.chatId, 'oc_hr'); assert.equal(text, 'HR authorized answer'); return { message_id: 'om_hr_reply' };
  } });
  assert.equal((await getSourceDelivery(hrReply.id)).state, 'delivered');
  assert.equal(queries, 1, 'HR replies do not enter the restricted query route');
  const collaborator = { ...event, messageId: 'om_collaborator', chatId: 'oc_collaborator',
    sender: { ...event.sender, openId: 'ou_collaborator' } };
  await recordRoleDeliveryContext(runtime(), collaborator, { responseId: 'feishu:om_collaborator', sessionId: 'agent-session' });
  const collaboratorReply = await enqueueSourceDelivery({ responseId: 'feishu:om_collaborator', sessionId: 'agent-session',
    text: 'Agent collaboration answer', sourceDelivery: sourceDelivery(collaborator) });
  assert.equal((await authorizeRoleDelivery(runtime(), collaboratorReply)).role, 'collaborator');
  assert.equal(await authorizeRoleDelivery({ config: { ...config, accessPolicy: { mode: 'roles',
    roles: { ...policy.roles, collaboratorOpenIds: [] } } } }, collaboratorReply), null);
  await processSourceDeliveryOnce(runtime(), { ...helpers, sendFeishuText: async (r, s, text) => {
    assert.equal(s.chatId, 'oc_collaborator'); assert.equal(text, 'Agent collaboration answer');
    return { message_id: 'om_collaborator_reply' };
  } });
  assert.equal((await getSourceDelivery(collaboratorReply.id)).state, 'delivered');
  assert.equal(queries, 1, 'collaborator replies retain general routing without being HR');
  for (const failed of [false, true]) {
    const responseId = `revoked-${failed}`;
    await recordRoleDeliveryContext(runtime(), event, { responseId });
    const pending = await enqueueSourceDelivery({ responseId, text: 'STALE AUTHORIZED DATA',
      sourceDelivery: sourceDelivery(event) });
    await processSourceDeliveryOnce(runtime(), { ...helpers, queryRestrictedInterview: async () => {
      if (failed) throw new Error('backend unavailable');
      return null;
    }, sendFeishuText: async (r,s,text) => {
      assert.equal(failed,true); assert.equal(text,INTERVIEW_QUERY_UNAVAILABLE);
      sends++; return {message_id:'om_error'};
    } });
    assert.equal((await getSourceDelivery(pending.id)).state, failed ? 'delivered' : 'cancelled');
    assert.equal(sends, failed ? 2 : 1, 'no stale data on revoked or failed queries');
  }
  console.log('PASS: real outbox round trip, restart, HR reply, scoped requery, tamper/revocation denial and legacy cancellation');
} finally { await rm(home, { recursive: true, force: true }); }
