const time = value => value == null ? NaN : typeof value === 'number' ? value : Date.parse(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const visible = new Set(['opening', 'progress', 'reply', 'question', 'final']);
const replies = new Set(['reply', 'question', 'final']);
const DAY = 86400000;

// Delivery receipts establish provider acceptance, not human reading or semantic
// usefulness. Do not inspect/copy text, or count automatic status/entry cards.
export function projectResponseTiming(request) {
  const o = request.options || {};
  const eligible = !request.nativeDispatchRunId && !o.internalOperation && !o.deliveryOnly
    && o.recordUserMessage !== false && !o.triggerId && !o.scheduleId && !o.automationTitle
    && (o.sourceContext?.connector === 'feishu' || request.deliveryPlan?.connector === 'feishu');
  if (!eligible) return null;
  const accepted = time(request.acceptedAt), settled = time(request.settledAt);
  let firstContentAt = null, firstReplyAt = null;
  for (const d of request.deliveries || []) {
    if (d.kind !== 'content' || d.connector !== 'feishu' || d.state !== 'delivered'
        || d.publicationRequestId && d.publicationRequestId !== request.requestId) continue;
    const delivered = time(d.deliveredAt);
    if (!Number.isFinite(accepted) || !Number.isFinite(delivered) || delivered < accepted) continue;
    // Older final delivery plans lack surfaceKind. Only a body created after
    // settlement is attributable; an unlabelled live message remains unknown.
    const kind = d.surfaceKind || (Number.isFinite(settled) && time(d.createdAt) >= settled ? 'final' : '');
    if (visible.has(kind)) firstContentAt = firstContentAt === null ? delivered : Math.min(firstContentAt, delivered);
    if (replies.has(kind)) firstReplyAt = firstReplyAt === null ? delivered : Math.min(firstReplyAt, delivered);
  }
  return { firstContentAt, firstReplyAt };
}
export function timingStats(values) {
  const a = values.filter(finite).sort((x,y) => x-y), count = a.length;
  return { count, mean: count ? a.reduce((x,y) => x+y,0)/count : null,
    median: count ? (a[Math.floor((count-1)/2)] + a[Math.floor(count/2)])/2 : null,
    p95: count ? a[Math.ceil(count*.95)-1] : null };
}
export function summarizeResponseTiming(samples, days = 7, now = Date.now()) {
  const start = Math.floor(now/DAY)*DAY - (days-1)*DAY;
  const selected = samples.filter(s => s.responseEligible && s.responseAt >= start && s.responseAt <= now);
  const stats = rows => ({ eligible: rows.length,
    firstContent: timingStats(rows.map(s => s.metrics.firstContentMs)),
    firstReply: timingStats(rows.map(s => s.metrics.firstReplyMs)) });
  return { ...stats(selected), timezone: 'UTC', start: new Date(start).toISOString(), end: new Date(now).toISOString(),
    days: Array.from({length:days},(_,i) => { const t=start+i*DAY;
      return { day:new Date(t).toISOString().slice(0,10), ...stats(selected.filter(s => s.responseAt >= t && s.responseAt < t+DAY)) }; }) };
}
