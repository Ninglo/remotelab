export function remotelabStatusSource(metrics, nowMs = Date.now()) {
  const observedAt = new Date(nowMs).toISOString();
  const validUntil = new Date(nowMs + 30_000).toISOString();
  const signals = [];
  const add = (id, phase, title, summary, subject, urgency = 'normal') => signals.push({
    id, phase, title, summary, subject, urgency,
    destination: '到 RemoteLab 查看详情',
    occurredAt: observedAt, expiresAt: validUntil, evidence: 'source_reported',
  });
  if (metrics.deliveryIssues > 0) {
    add('delivery-issues', 'incident', '近期有投递异常记录',
      `近 24 小时记录到 ${metrics.deliveryIssues} 条，是否仍需处理请到 RemoteLab 核对。`, '消息投递', 'high');
  }
  if (metrics.running > 0) {
    add('running', 'progress', `${metrics.running} 项任务正在运行`,
      '任务仍在执行；这块屏只展示概况，不展示会话正文。', 'RemoteLab Session');
  }
  if (metrics.queued > 0) {
    add('queued', 'progress', `${metrics.queued} 项请求正在排队`,
      '等待中的请求会由 RemoteLab 继续调度。', 'RemoteLab 队列');
  }
  if (metrics.pendingReview > 0) {
    add('pending-review', 'note', `${metrics.pendingReview} 条结果待浏览`,
      '这是近 24 小时的浏览候选，并不表示都需要你采取行动。', 'RemoteLab 结果', 'low');
  }
  return { schemaVersion: 1, sequence: nowMs, label: 'RemoteLab', observedAt, validUntil, signals };
}
