// Publish what an admitted worker actually did through the native outbox.
// Gate checks and preflight failures never create a group topic.
import { join } from 'node:path';
import { read, save } from './store.mjs';

export async function deliverReview(root, worker, runId, sessionId) {
  const target = worker.config.resultDelivery;
  if (!target) return { state: 'disabled' };
  if (!/^run_[a-zA-Z0-9_-]+$/.test(runId || '')) throw new Error('Invalid review Run');
  const review = await read(join(root, 'reviews', `${runId}.json`), null);
  const state = await read(join(root, 'state.json'));
  const attempt = state.attempts.find(a => a.runId === runId);
  const committed = review && attempt?.committed;
  if (!committed && !attempt?.claimedAt) return { state: 'not_started' };
  if (attempt?.sessionId && attempt.sessionId !== sessionId
    || review && (review.runId !== runId || review.sessionId !== sessionId)) throw new Error('Review owner mismatch');
  if (!['completed', 'cancelled', 'failed'].includes(attempt.state)) return { state: 'running' };
  if (target.connector !== 'feishu' || !target.sourceRouteId || !target.target?.chatId) throw new Error('Explicit Feishu result target required');

  const path = join(root, 'deliveries', `${runId}.json`);
  let receipt = await read(path, null);
  if (receipt?.deliveryId) return receipt;
  if (!receipt) {
    const base = new URL(worker.config.publicBaseUrl);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid public Session base URL');
    base.search = new URLSearchParams({ session: sessionId, tab: 'sessions' }).toString();
    base.hash = '';
    const summary = committed
      ? `Dreaming 已启动并完成本轮复盘。\n\n${review.result.activitySummary || review.result.finding}`
      : `Dreaming 本轮已启动，已领取 ${attempt.batchItemCount || 0} 条材料；${attempt.state === 'cancelled' ? '运行中被中断' : attempt.state === 'failed' ? '执行失败' : '未提交有效复盘结果'}。${attempt.stopReason ? `原因：${attempt.stopReason}。` : ''}\n材料和已有草稿保留，尚未验收方法改进。`;
    receipt = {
      state: 'prepared',
      preparedAt: new Date().toISOString(),
      packet: {
        sessionId,
        responseId: `dreaming-result:${runId}`,
        scheduleId: worker.config.scheduleId,
        sourceDelivery: target,
        text: `${summary}\n\n[查看执行记录并接续工作](${base.href})`,
      },
    };
    // Freeze the exact packet before an uncertain network write.
    await save(path, receipt);
  }
  const session = (await worker.api(`/api/sessions/${encodeURIComponent(sessionId)}`)).session;
  if (!session) throw new Error('Review Session missing');
  const bound = session.conversation, destination = receipt.packet.sourceDelivery;
  if (bound) {
    if (bound.connector !== destination.connector || bound.sourceRouteId !== destination.sourceRouteId
      || bound.target?.chatId !== destination.target.chatId) throw new Error('Review Session already belongs to another conversation');
  } else {
    await worker.api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: { conversation: destination } });
  }
  const { delivery } = await worker.api('/api/source-deliveries', { method: 'POST', body: receipt.packet });
  if (!delivery?.id) throw new Error('Outbox returned no delivery receipt');
  receipt = { ...receipt, state: 'queued', deliveryId: delivery.id, queuedAt: new Date().toISOString() };
  await save(path, receipt);
  return receipt;
}
