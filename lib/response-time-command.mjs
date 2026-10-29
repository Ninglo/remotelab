import { createRemoteLabHttpClient } from './remotelab-http-client.mjs';
import { requests } from '../chat/requests.mjs';
import { projectResponseTiming } from '../chat/response-timing.mjs';

const time = value => value == null ? NaN : typeof value === 'number' || /^\d{13}$/.test(value) ? Number(value) : Date.parse(value);
const span = (a, b) => Number.isFinite(time(a)) && time(b) >= time(a) ? time(b) - time(a) : null;
const help = `Usage:
  remotelab response-time [--days 1|7] [--base-url URL] [--json]
  remotelab response-time --request-id ID [--session ID] [--json]

Summary: one read of the existing monitoring cache; no transcript or spool scan.
Request: exact local receipt lookup; --session defaults to REMOTELAB_SESSION_ID.
Times end at provider delivery, not model generation or human reading.
Missing receipts remain unknown. No model calls, settings changes or background jobs.
`;

// Project existing statistics verbatim. Daily quantiles cannot be averaged into
// a weekly quantile, and group-mainline first replies are not final deliveries.
export function responseTimeSummary(snapshot, days = 1) {
  const d = snapshot?.agentDashboard;
  if (d?.schema !== 2 || d.responseScope !== 'ordinary-input' || !Array.isArray(d.days))
    throw new Error('Monitoring response timing is unavailable or uses an unsupported schema');
  const group = d.groupParticipation;
  return {
    source: '/api/monitoring/sessions?days=1&dashboard=1',
    generatedAt: snapshot.generatedAt, timezone: d.timezone, dayStartHour: d.dayStartHour,
    days: d.days.slice(-days).map(day => ({
      day: day.day, start: day.start,
      ordinary: {
        firstResponseMs: day.firstResponse,
        finalDeliveryMs: day.journeyStages?.total ?? null,
        acceptedToFinalMs: day.delivery,
        stagesMs: day.journeyStages,
        coverage: day.originCoverage,
      },
      groupMainline: {
        firstResponseMs: group?.days?.find(row => row.day === day.day)?.textLatency ?? null,
        finalDeliveryMs: null,
      },
    })),
    coverage: d.coverage || snapshot.coverage,
    groupCoverage: group?.coverage ?? null,
    semantics: {
      firstResponse: d.semantics?.firstResponse,
      finalDelivery: '消息发出至最终正文送达；复用监控中阶段时间齐全且有序的样本，不等于任务验收。',
      acceptedToFinal: d.semantics?.delivery,
      stages: d.semantics?.journey,
      groupMainline: '普通群主线单列首响；现有群统计未提供完整交付耗时，不能用首响替代。',
      window: '北京时间 05:00 分日；七日按天列出，未合成分位数。未回传或缺回执不算零耗时。',
    },
  };
}

export async function requestResponseTime(sessionId, requestId, store = requests) {
  const record = await store.byRequest(sessionId, requestId);
  if (!record) throw new Error('Request not found in the selected instance/session');
  if (record.options?.sourceContext?.connector !== 'feishu') throw new Error('This request has no Feishu source delivery timing');
  const ownerId = record.mainlineReply?.contract?.ownerRequestId;
  const owner = ownerId && ownerId !== requestId ? await store.byRequest(sessionId, ownerId)
    : record.nativeDispatchRunId ? await store.byRunId(record.nativeDispatchRunId) : record;
  const receipts = new Map();
  for (const source of [record, owner].filter(Boolean)) {
    const contract = source.mainlineReply?.contract;
    for (const d of source.deliveries || []) {
      const belongs = d.publicationRequestId ? d.publicationRequestId === requestId
        : source.requestId === requestId || contract?.requestIds?.includes(requestId)
          && d.providerMessageId === contract.providerMessageId;
      if (!belongs || d.connector !== 'feishu' || !['content', 'attachment'].includes(d.kind)) continue;
      const surfaceKind = d.surfaceKind || (time(d.createdAt) >= time(source.settledAt) ? 'final' : '');
      receipts.set(d.id, { ...d, surfaceKind, publicationRequestId: requestId });
    }
  }
  const deliveries = [...receipts.values()];
  // Ownership was resolved above for a steered input; no Run-wide attribution.
  const timing = projectResponseTiming({ ...record, nativeDispatchRunId: null, deliveries });
  const sentAt = record.options.sourceContext.createTime;
  const finals = deliveries.filter(d => d.surfaceKind === 'final');
  const finalAt = finals.length && finals.every(d => d.state === 'delivered' && Number.isFinite(time(d.deliveredAt)))
    ? Math.max(...finals.map(d => time(d.deliveredAt))) : null;
  return {
    source: 'existing-request-receipts', generatedAt: new Date().toISOString(), sessionId, requestId,
    executionState: record.result?.state || 'running',
    replyState: finalAt === null ? finals.length ? 'awaiting-delivery' : 'no-final-receipt' : 'delivered',
    metricsMs: {
      firstResponse: span(sentAt, timing?.firstContentAt),
      firstReply: span(sentAt, timing?.firstReplyAt),
      finalDelivery: span(sentAt, finalAt),
      acceptedToFinal: span(record.acceptedAt, finalAt),
      receive: span(sentAt, record.acceptedAt),
      preparation: span(record.acceptedAt, record.preparedAt),
    },
    receiptIds: deliveries.filter(d => d.state === 'delivered').map(d => d.id),
    semantics: '首次回应含开场；首次答复含提问、补充答复和最终答复，不等于完整交付。完整交付需最终正文及声明附件均有送达回执；不代表任务验收。缺回执为未知，运行状态单独列出。',
  };
}

const seconds = value => typeof value === 'number' && Number.isFinite(value) ? `${(value / 1000).toFixed(1)} 秒` : '未知';
const stat = value => value?.count > 0 ? `中位 ${seconds(value.median)}；P95 ${seconds(value.p95)}；n=${value.count}` : '未知（无有效样本）';
export function renderResponseTime(value) {
  const lines = [`统计时间：${value.generatedAt}`];
  if (value.metricsMs) {
    lines.push(`首次回应：${seconds(value.metricsMs.firstResponse)}`, `完整交付：${seconds(value.metricsMs.finalDelivery)}`,
      `回复状态：${value.replyState}；执行状态：${value.executionState}`, value.semantics);
  } else {
    lines.push('北京时间 05:00 分日；首响包含开场，排除表情和自动状态。');
    for (const day of value.days) lines.push(`${day.day} 普通会话（私聊／话题）：`,
      `  首次回应：${stat(day.ordinary.firstResponseMs)}`,
      `  完整交付：${stat(day.ordinary.finalDeliveryMs)}`,
      `  接收／准备／启动／执行／发送中位：${['receive', 'prepare', 'launch', 'run', 'send'].map(k => seconds(day.ordinary.stagesMs?.[k]?.median)).join(' / ')}`,
      `  群主线首次回应：${stat(day.groupMainline.firstResponseMs)}；完整交付：未提供`);
    lines.push('首响与完整交付可能覆盖不同样本；完整交付不等于任务验收。',
      `覆盖：${JSON.stringify(value.coverage)}；群覆盖：${JSON.stringify(value.groupCoverage)}`);
  }
  return lines.join('\n') + '\n';
}

export async function runResponseTimeCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(help); return 0; }
  const options = { days: 1, session: process.env.REMOTELAB_SESSION_ID, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    const key = { '--days': 'days', '--session': 'session', '--request-id': 'requestId', '--base-url': 'baseUrl' }[arg];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid option: ${arg}`);
    options[key] = argv[++i];
  }
  if (![1, 7].includes(Number(options.days))) throw new Error('--days must be 1 or 7');
  let result;
  if (options.requestId) {
    if (!options.session) throw new Error('--request-id requires --session or REMOTELAB_SESSION_ID');
    if (options.baseUrl) throw new Error('Exact request lookup is local; do not combine --request-id and --base-url');
    result = await requestResponseTime(options.session, options.requestId, io.store || requests);
  } else {
    if (argv.includes('--session')) throw new Error('--session requires --request-id; summary covers the monitored instance');
    const client = io.client || createRemoteLabHttpClient({ baseUrl: options.baseUrl });
    const response = await client.request('/api/monitoring/sessions?days=1&dashboard=1', { signal: AbortSignal.timeout(60_000) });
    if (!response.response.ok) throw new Error(response.json?.error || `Monitoring request failed (${response.response.status})`);
    result = responseTimeSummary(response.json, Number(options.days));
  }
  stdout.write(options.json ? JSON.stringify(result, null, 2) + '\n' : renderResponseTime(result));
  return 0;
}
