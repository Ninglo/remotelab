import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feishu-card-renewal-'));
setIsolatedTestHome(home);
try {
  const { createParticipationController } = await import('../connectors/feishu/participation-state.mjs');
  const { createRecordStore } = await import('../lib/durable-records.mjs');
  const { CARD_RENEWAL_NOTICE } = await import('../connectors/feishu/card-renewal.mjs');
  const store = createRecordStore(join(home, 'participation-state'));
  const oldTime = Date.now() - 14 * 86400_000;
  const options = { existingOnly: true, renewExisting: true };
  const sends = [], patches = [], pins = [];
  let getCount = 0, failPin = false, uncertainSend = false, rejectSend = false, expirePatch = false;
  const runtime = { config: { storageDir: home, sourceRouteId: 'fixture', groups: {} }, storagePaths: {},
    appClient: { im: { v1: {
      message: {
        get: async ({ path }) => { getCount++; return { code: 0, data: { items: [
          { message_id: path.message_id, create_time: String(oldTime) },
        ] } }; },
        create: async payload => {
          sends.push(payload);
          if (uncertainSend) throw new Error('Acknowledgement lost');
          if (rejectSend) return { code: 99991672, msg: 'Permission denied' };
          return { code: 0, data: { message_id: `new-${sends.length}` } };
        },
        patch: async payload => {
          patches.push(payload);
          if (expirePatch && payload.path.message_id.startsWith('old-')) {
            throw Object.assign(new Error('Expired'), { code: 230031, httpStatus: 400, logId: 'expiry-log' });
          }
          return { code: 0 };
        },
      },
      chatTopNotice: { putTopNotice: async payload => {
        pins.push(payload);
        if (failPin) throw new Error('Pin temporarily failed');
        return { code: 0 };
      } },
    } } },
  };
  let controller = createParticipationController(runtime);
  const source = name => ({ chatId: name, tenantKey: 'tenant', chatType: 'group', chatMode: 'group' });
  async function seed(name, extra = {}) {
    const record = await controller.state(source(name));
    return store.mutate(record.key, () => ({ ...record, cardMessageId: `old-${name}`, cardCreatedAt: oldTime,
      mode: 'listening', modeOverride: true, ...extra }));
  }

  const legacy = await seed('legacy', { cardCreatedAt: 0 });
  await Promise.all([controller.publish(legacy, options), controller.publish(legacy, options)]);
  const renewed = await store.get(legacy.key);
  assert.equal(getCount, 1, 'read and persist legacy creation time once');
  assert.equal(sends.length, 1, 'concurrent refreshes renew only once');
  assert(sends[0].data.content.includes(CARD_RENEWAL_NOTICE));
  assert.equal(sends[0].data.receive_id, legacy.source.chatId);
  assert.equal(renewed.mode, 'listening');
  assert.equal(renewed.cardHistory[0].messageId, legacy.cardMessageId);
  assert.equal(renewed.cardHistory[0].createdAt, oldTime);
  assert.equal(renewed.pinPending, false);
  assert(!patches.some(call => call.path.message_id === legacy.cardMessageId));

  const pin = await seed('pin');
  failPin = true;
  await assert.rejects(controller.publish(pin, options), /Pin temporarily/);
  const pendingPin = await store.get(pin.key);
  assert.equal(pendingPin.pinPending, true);
  assert.notEqual(pendingPin.cardMessageId, pin.cardMessageId);
  failPin = false;
  controller = createParticipationController(runtime);
  await controller.publish(pin, options);
  assert.equal(sends.length, 2, 'pin recovery after restart reuses the successful send');
  assert.equal((await store.get(pin.key)).pinPending, false);

  const unexpected = await seed('unexpected', { cardCreatedAt: Date.now() });
  expirePatch = true;
  await controller.publish(unexpected, options);
  assert.equal(sends.length, 3, 'provider expiry overrides an inaccurate local age');
  assert.equal(patches.filter(p => p.path.message_id === unexpected.cardMessageId).length, 1);
  assert.equal((await store.get(unexpected.key)).cardHistory[0].updateFailure.logId, 'expiry-log');
  expirePatch = false;

  const uncertain = await seed('uncertain');
  uncertainSend = true;
  await assert.rejects(controller.publish(uncertain, options), /Acknowledgement lost/);
  controller = createParticipationController(runtime);
  await assert.rejects(controller.publish(uncertain, options), /发送结果待核实/);
  assert.equal(sends.length, 4, 'unknown send is never automatically repeated');
  assert.equal((await store.get(uncertain.key)).cardMessageId, uncertain.cardMessageId);
  uncertainSend = false;

  const rejected = await seed('rejected');
  rejectSend = true;
  await assert.rejects(controller.publish(rejected, options), /Permission denied/);
  assert.equal((await store.get(rejected.key)).cardRenewalPending, null, 'definite rejection is not an uncertain send');
  assert((await store.get(rejected.key)).cardRenewalFailure.error.includes('99991672'));
  rejectSend = false;
  await controller.publish(rejected, options);
  assert.equal(sends.length, 6);
  assert.equal(sends[4].data.uuid, sends[5].data.uuid, 'renewal key is tied to the old message');

  const hidden = await seed('hidden', { cardSuppressed: true });
  await controller.publish(hidden, options);
  assert.equal(sends.length, 6, 'withdrawn cards stay withdrawn');
  const patchOnly = await seed('patch-only');
  const before = patches.length;
  await controller.publish(patchOnly, { existingOnly: true });
  assert.equal(patches.length, before, 'read-only restoration does not retry an expired message');
  assert.equal(sends.length, 6);
  await controller.idle();
  console.log('PASS: renewal source, legacy age, concurrency, pause preservation, expiry fallback, pin recovery and uncertain sends');
} finally { await rm(home, { recursive: true, force: true }); }
