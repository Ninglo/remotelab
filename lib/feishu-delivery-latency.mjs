// Fixed technical facts, never user text. A delivered receipt is not a read receipt.
const time = v => v == null ? NaN : typeof v === 'number' || /^\d{13}$/.test(v) ? Number(v) : Date.parse(v);
const span = (a,b) => Number.isFinite(time(a)) && time(b) >= time(a) ? time(b)-time(a) : null;
export const latencyFacts = Object.freeze({
  pickup: ['Feishu first outbound claim took over 10s after eligibility','飞书出站首次领取慢','投递已到可领取时间，超过 10 秒才首次领取；其中可能包含同话题顺序等待。','核对领取唤醒、同目标前序租约和领取耗时，不要重发原消息。'],
  receipt: ['Feishu outbound claim to delivery receipt took over 10s','飞书领取后回执慢','领取后超过 10 秒才记录送达；其中包含发送和本地确认，不等于飞书 API 耗时。','对照提供方确认和本地回写时间，不要重跑模型。'],
  opening: ['Feishu first visible opening arrived over 30s after send','飞书开场文字送达慢','首条可见文字是开场，距原消息发出超过 30 秒；不能归咎于某个模型。','按原消息查受理、上下文准备、实际执行工具和投递各段。'],
});
export function deliverySpans(d, sentAt) {
  return { fromSendMs:span(sentAt,d?.deliveredAt), queueMs:span(d?.createdAt,d?.claimedAt),
    eligibleToClaimMs:d?.attempts===1?span(d?.availableAt,d?.claimedAt):null,
    claimToReceiptMs:d?.state==='delivered'?span(d.claimedAt,d.deliveredAt):null };
}
export function slowCompletedDelivery(record,d) {
  const o=record?.options;
  if (o?.sourceContext?.connector!=='feishu' || o.internalOperation || o.deliveryOnly || o.triggerId || o.scheduleId
    || o.recordUserMessage===false || !record.requestId?.startsWith('feishu:om_') || d?.state!=='delivered' || d.connector!=='feishu'
    || d.publicationRequestId && d.publicationRequestId!==record.requestId || d.target?.messageId!==record.requestId.slice(7)) return [];
  if (!(d.kind==='reaction'&&d.processingState==='active') && !(d.kind==='content'&&['opening','progress','question','reply','final'].includes(d.surfaceKind))) return [];
  const s=deliverySpans(d,o.sourceContext.createTime), keys=[];
  if (s.eligibleToClaimMs>10000) keys.push('pickup');
  if (s.claimToReceiptMs>10000) keys.push('receipt');
  if (d.surfaceKind==='opening' && s.fromSendMs>30000 && !record.deliveries.some(x=> x.id!==d.id && x.connector==='feishu' && x.kind==='content' && x.state==='delivered' && (!x.publicationRequestId || x.publicationRequestId===record.requestId) && time(x.deliveredAt)<=time(d.deliveredAt))) keys.push('opening');
  return keys;
}
