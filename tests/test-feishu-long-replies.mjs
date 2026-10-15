import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feishu-long-replies-'));
setIsolatedTestHome(home);
const { sendFeishuText, processSourceDeliveryOnce } = await import('../scripts/feishu-connector.mjs');
const outbox = await import('../chat/source-deliveries.mjs');
const target = { chatId: 'chat', messageId: 'anchor', threadId: 'thread', replyInThread: true };
const text = '# 完整答复\n\n' + '中文完整内容。'.repeat(1600) + '\n\n最后一段：不能丢失。';
const requestRemoteLab = async (path, { body = {} } = {}) => {
  if (path.endsWith('/claim')) return { response: { ok: true }, json: { claim: await outbox.claimSourceDelivery(body) } };
  const [, id, action] = /\/api\/source-deliveries\/([^/]+)\/(complete|fail|resolve)/.exec(path) || [];
  assert(id, path);
  const delivery = action === 'complete' ? await outbox.completeSourceDelivery(id, body.leaseId, body)
    : action === 'fail' ? await outbox.failSourceDelivery(id, body.leaseId, body.error, body)
    : await outbox.resolveSourceDelivery(id, body);
  return { response: { ok: true }, json: { delivery } };
};
function fixture(route) {
  const uploads = [], sends = [];
  const runtime = { config: { sourceRouteId: route, storageDir: join(home, route) },
    appClient: { im: { v1: {
      file: { create: async payload => { uploads.push(payload); return { file_key: 'file_full' }; } },
      message: {
        reply: async payload => { sends.push(payload); return { code: 0, data: { message_id: `sent-${route}`, thread_id: 'thread' } }; },
        create: async payload => { sends.push(payload); return { code: 0, data: { message_id: `sent-${route}` } }; },
      },
    } } } };
  return { runtime, uploads, sends };
}
async function enqueue(route, body = text) {
  return outbox.enqueueSourceDelivery({ sessionId: route, responseId: 'answer', text: body,
    sourceDelivery: { connector: 'feishu', sourceRouteId: route, target } });
}

try {
  // Exactly at the old limit remains a normal post; the next character is
  // preserved in a file. The file must not expose hidden model content.
  const f = fixture('boundary');
  await sendFeishuText(f.runtime, target, 'a'.repeat(5000), 'boundary-5000');
  assert.equal(f.sends[0].data.msg_type, 'post');
  assert.equal(f.uploads.length, 0);
  const full = 'a'.repeat(5000) + '尾';
  await sendFeishuText(f.runtime, target, `<private>secret</private>${full}<hide>hidden</hide>`, 'boundary-5001');
  assert.equal(f.uploads[0].data.file.toString('utf8'), full);
  assert.equal(f.uploads[0].data.file_name, '完整答复.md');
  assert.equal(f.sends[1].data.msg_type, 'file');
  assert.equal(f.sends[1].data.uuid, 'boundary-5001');
  assert.equal(f.sends[1].path.message_id, 'anchor');
  assert.equal(f.sends[1].data.reply_in_thread, true);
  assert.equal(f.sends.length, 2, 'one visible send per reply');

  // JSON/markup overhead can overflow the budget without 5,000 characters.
  const markup = '\u0001'.repeat(4500);
  await sendFeishuText(f.runtime, target, markup, 'expanded-payload');
  assert.equal(f.sends.at(-1).data.msg_type, 'file');
  assert.equal(f.uploads.at(-1).data.file.toString('utf8'), markup);

  // Mainline and private destinations keep their normal routing.
  await sendFeishuText(f.runtime, { chatId: 'private' }, text, 'private-full');
  assert.equal(f.sends.at(-1).data.receive_id, 'private');
  await sendFeishuText(f.runtime, { chatId: 'group', chatType: 'group', messageId: 'main' }, text, 'main-full');
  assert.equal(f.sends.at(-1).path.message_id, 'main');
  assert.equal(f.sends.at(-1).data.reply_in_thread, false);

  // A lost acknowledgement, before or after controller commit, is recovered
  // from the durable connector receipt with zero additional provider calls.
  for (const committed of [false, true]) {
    const route = `ack-${committed}`;
    const g = fixture(route);
    const delivery = await enqueue(route);
    await processSourceDeliveryOnce(g.runtime, { requestRemoteLab: async (path, options) => {
      if (path.endsWith('/complete')) {
        if (committed) await requestRemoteLab(path, options);
        return { response: { ok: false }, json: { error: 'controller disconnected' } };
      }
      return requestRemoteLab(path, options);
    } });
    assert.equal(g.uploads.length, 1);
    assert.equal(g.uploads[0].data.file.toString('utf8'), text);
    assert.equal(g.sends.length, 1);
    assert.equal(g.sends[0].data.uuid, delivery.id);
    const restarted = { ...g.runtime };
    delete restarted.deliveryReceipts;
    await processSourceDeliveryOnce(restarted, { requestRemoteLab, receiptReplayOptions: { now: Date.now() + 60000 } });
    assert.equal((await outbox.getSourceDelivery(delivery.id)).state, 'delivered');
    assert.equal(g.uploads.length, 1);
    assert.equal(g.sends.length, 1);
  }

  // Upload failures happen before visible sends and can safely retry.
  const upload = fixture('upload');
  const uploadDelivery = await enqueue('upload');
  const originalUpload = upload.runtime.appClient.im.v1.file.create;
  upload.runtime.appClient.im.v1.file.create = async () => { throw Object.assign(new Error('upload disconnected'), { code: 'ECONNRESET' }); };
  await assert.rejects(processSourceDeliveryOnce(upload.runtime, { requestRemoteLab }));
  assert.equal((await outbox.getSourceDelivery(uploadDelivery.id)).state, 'pending');
  assert.equal(upload.sends.length, 0);
  upload.runtime.appClient.im.v1.file.create = originalUpload;
  await processSourceDeliveryOnce(upload.runtime, { requestRemoteLab: async (path, options) => {
    if (path.endsWith('/claim')) options = { ...options, body: { ...options.body, now: Date.now() + 60000 } };
    return requestRemoteLab(path, options);
  } });
  assert.equal((await outbox.getSourceDelivery(uploadDelivery.id)).state, 'delivered');
  assert.equal(upload.sends.length, 1);

  // A message timeout is uncertain: do not upload/send the original again.
  // Subsequent ordinary replies must still be able to complete.
  const uncertain = fixture('uncertain');
  const uncertainDelivery = await enqueue('uncertain');
  const originalReply = uncertain.runtime.appClient.im.v1.message.reply;
  let timeouts = 0;
  uncertain.runtime.appClient.im.v1.message.reply = async () => {
    timeouts++; throw Object.assign(new Error('message timeout'), { code: 'ETIMEDOUT' });
  };
  await assert.rejects(processSourceDeliveryOnce(uncertain.runtime, { requestRemoteLab }));
  assert.equal((await outbox.getSourceDelivery(uncertainDelivery.id)).state, 'unknown');
  uncertain.runtime.appClient.im.v1.message.reply = originalReply;
  const later = await outbox.enqueueSourceDelivery({ sessionId: 'uncertain', responseId: 'later', text: '普通回复',
    sourceDelivery: { connector: 'feishu', sourceRouteId: 'uncertain', target } });
  await processSourceDeliveryOnce(uncertain.runtime, { requestRemoteLab });
  await processSourceDeliveryOnce(uncertain.runtime, { requestRemoteLab });
  assert.equal((await outbox.getSourceDelivery(later.id)).state, 'delivered');
  assert.equal(uncertain.uploads.length, 1);
  assert.equal(timeouts, 1);
  assert.equal(uncertain.sends.at(-1).data.msg_type, 'post');
  console.log('Feishu long replies: complete files, payload budget, routing, safe retries and restart recovery passed');
} finally {
  await rm(home, { recursive: true, force: true });
}
