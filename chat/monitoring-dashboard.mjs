import { timingStats } from './response-timing.mjs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_DIR } from '../lib/config.mjs';

export const DAY = 86400000;
// 05:00 Asia/Shanghai = 21:00 UTC on the previous calendar date.
export const BUSINESS_OFFSET = -3 * 3600000;
export const businessStart = now => Math.floor((now - BUSINESS_OFFSET) / DAY) * DAY + BUSINESS_OFFSET;
export const businessDate = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
const chars = text => [...text].length;
export const sourceFiles = {
  remotelab_startup: ['入口与能力', 'chat/prompt-assets/system/startup-context.md'],
  active_rule_context: ['当前规则与恢复入口', 'chat/rule-context.mjs'],
  surface_messages: ['消息展示规则', 'chat/prompt-assets/system/surface-messages.md'],
  session_workboard: ['任务清单规则', 'chat/session-manager.mjs'],
  source_runtime: ['来源与运行规则', 'chat/session-manager.mjs'],
  session_instructions: ['Session 约定', 'chat/session-manager.mjs'],
  turn_context: ['本轮背景：人员、项目与群消息', 'docs/connector-turn-context.md'],
  project_memory: ['项目说明与原件入口', 'chat/project-memory-runtime.mjs'],
  project_work_directory: ['隐藏项目工作目录', 'chat/project-work-directory.mjs'],
  message_reply_mode: ['个人回复设置', 'chat/session-manager.mjs'],
  strict_start_check: ['开工检查 v1', 'chat/prompt-assets/experiments/work-start/v1.md'],
  inflight_trial: ['执行中补充输入规则', 'chat/session-manager.mjs'],
  inflight_trial_input: ['本条输入定位', 'chat/system-prompt.mjs'],
};

const documents = [
  { id: 'workspace_agents', name: 'AGENTS.md · 工作区约定', path: join(homedir(), 'AGENTS.md'), when: 'Harness 按工作目录加载；不计入下方 RemoteLab 注入量' },
  { id: 'bootstrap', name: 'bootstrap.md · 实例与资料入口', path: join(MEMORY_DIR, 'bootstrap.md'), when: '入口指针随启动提供，正文按需读取' },
  { id: 'project_index', name: 'projects.md · 项目目录', path: join(MEMORY_DIR, 'projects.md'), when: '项目背景入口；正文按任务需要读取' },
  { id: 'skill_index', name: 'skills.md · 专用方法目录', path: join(MEMORY_DIR, 'skills.md'), when: '检索候选／按需读取，不等于所有 Skill 正文自动注入' },
  { id: 'remotelab_startup', name: 'startup-context.md · RemoteLab 启动说明', when: '新的原生会话启动时投射；实际版本可能含动态部分' },
  { id: 'surface_messages', name: 'surface-messages.md · 展示默认规则', when: '默认规则；个人已确认设置可替代' },
  { id: 'strict_start_check', name: 'work-start/v1.md · 开工检查', when: '仅在当前发起人的实验开关开启时投射' },
];
export async function readContextSource(id) {
  const document = documents.find(d => d.id === id);
  const source = Object.hasOwn(sourceFiles, id) ? sourceFiles[id] : null;
  const file = document?.path || (source ? new URL('../' + source[1], import.meta.url) : null);
  if (!file) return null;
  try {
    if ((await stat(file)).size > 1024 * 1024) return null;
    return await readFile(file, 'utf8');
  } catch { return null; }
}
export async function readContextDocuments() {
  return Promise.all(documents.map(async ({ id, name, when }) => {
    const text = await readContextSource(id);
    return { id, name, when, chars: text === null ? null : chars(text) };
  }));
}

// Section boundaries are the recorded slot headings, not arbitrary Markdown
// headings inside a document. Retain sizes only, never private prompt bodies.
export function injectionSources(manifest) {
  const text = manifest?.modelContext;
  if (typeof text !== 'string') return [];
  const slots = manifest.modelContextSlots || [];
  let from = 0;
  const found = [];
  for (const slot of slots) {
    const heading = `## ${slot.title}\n\n`;
    const at = text.indexOf(heading, from);
    if (at < 0) return [];
    found.push({ slot, at }); from = at + heading.length;
  }
  return found.map(({ slot, at }, i) => {
    const info = sourceFiles[slot.id];
    return { id: slot.id, name: info?.[0] || String(slot.title).slice(0, 180),
      chars: chars(text.slice(at, found[i + 1]?.at ?? text.length)),
      delivery: slot.delivery,
      sourcePath: info?.[1] || null };
  });
}

const stageStats = rows => Object.fromEntries(['total', 'wait', 'run', 'send'].map(stage =>
  [stage, timingStats(rows.map(s => s.metrics.deliveryStages?.[stage]))]));

export function buildAgentDashboard(usage, samples, now, coverage) {
  const start = businessStart(now) - 6 * DAY;
  const foreground = samples.filter(s => !s.background);
  const days = Array.from({ length: 7 }, (_, i) => {
    const at = start + i * DAY;
    const rows = foreground.filter(s => s.responseAt >= at && s.responseAt < at + DAY);
    const ordinaryRows = rows.filter(s => s.origin?.kind === 'ordinary');
    const first = rows.filter(s => s.firstSessionRun === true);
    const allSentRows = foreground.filter(s => s.responseEligible && s.sentAt >= at && s.sentAt < at + DAY);
    const sentRows = allSentRows.filter(s => s.origin?.kind === 'ordinary');
    const originCoverage = { ordinary: sentRows.length,
      groupMainline: allSentRows.filter(s => s.origin?.kind === 'group-mainline').length,
      unknown: allSentRows.filter(s => !s.origin || s.origin.kind === 'unknown').length,
      requestFallback: allSentRows.filter(s => s.origin?.basis === 'request').length };
    const firstResponse = timingStats(sentRows.map(s => s.metrics.firstResponseMs));
    const journeyStages = Object.fromEntries(['receive', 'prepare', 'launch', 'run', 'send', 'total'].map(stage =>
      [stage, timingStats(sentRows.map(s => s.metrics.journeyStages?.[stage]))]));
    const ledger = usage.dailyTrend?.days?.find(d => d.day === businessDate(at));
    const injection = timingStats(rows.map(s => s.metrics.injectionChars));
    const firstInjection = timingStats(first.map(s => s.metrics.injectionChars));
    const delivery = timingStats(ordinaryRows.map(s => s.metrics.finalDeliveryMs));
    const firstDelivery = timingStats(ordinaryRows.filter(s => s.firstSessionRun).map(s => s.metrics.finalDeliveryMs));
    return { day: businessDate(at), start: new Date(at).toISOString(),
      sessions: ledger?.sessionCount ?? null, usageRuns: ledger?.runCount || 0,
      totalTokens: ledger?.totalTokens ?? null,
      meanTokens: ledger?.runCount ? ledger.totalTokens / ledger.runCount : null,
      foregroundTokens: ledger?.foregroundTokens ?? null, backgroundTokens: ledger?.backgroundTokens ?? null,
      meanInjectionChars: injection.mean, firstInjectionChars: firstInjection.mean,
      meanDeliveryMs: delivery.mean, firstDeliveryMs: firstDelivery.mean,
      injection, firstInjection, delivery, firstDelivery,
      meanFirstResponseMs: firstResponse.mean, firstResponse, journeyStages, originCoverage,
      deliveryStages: stageStats(ordinaryRows), firstDeliveryStages: stageStats(ordinaryRows.filter(s => s.firstSessionRun)),
      measuredRuns: rows.length, firstRuns: first.length,
      unknownFirstRuns: rows.filter(s => s.firstSessionRun == null).length };
  });
  const exemplar = foreground.filter(s => s.firstSessionRun && s.sources?.length)
    .sort((a, b) => b.responseAt - a.responseAt)[0];
  return { schema: 2, responseScope: 'ordinary-input', timezone: 'Asia/Shanghai', dayStartHour: 5,
    generatedAt: new Date(now).toISOString(), start: new Date(start).toISOString(),
    today: days.at(-1), days,
    sources: exemplar ? { sessionId: exemplar.sessionId, runId: exemplar.runId,
      observedAt: new Date(exemplar.responseAt).toISOString(), chars: exemplar.metrics.injectionChars,
      entries: exemplar.sources } : null,
    coverage: { ...coverage, eligibleRuns: usage.trendRunCount ?? usage.runCount, sampledRuns: samples.length,
      truncated: (usage.trendRunCount ?? usage.runCount) > samples.length || coverage.limitedFiles > 0 },
    semantics: { usage: '含前后台，按运行结束／账本记账日归集；均值分母为有用量记录的执行次数。跨日运行不拆分，未回传部分不计入。',
      injection: '按人工请求受理日归集，统计 RemoteLab modelContext 的 Unicode 字符数（含标题与分隔符）；不含 Harness 自身规则、原生历史和工具输出。',
      first: 'Session 历史中第一条用户消息对应的首次执行；窗口内最早记录不代替首轮。无法确认时不计入首轮均值。',
      firstResponse: '普通会话首次回复：按原始入站消息区分来源，剔除普通群主线与来源未知；包含私聊、原生话题群和话题续聊。入站记录缺失时仅采用能判定的请求来源并单列覆盖，回复目标不替代原始来源。从消息发出到首条文字成功送达，包含开场、进展、答复、提问和最终结果，排除表情与自动受理。仅覆盖已落账 Run 的可归属首条飞书请求，按发送日统计；缺少时间或回执不计入，送达不代表已读。',
      journey: '各环节用时表按消息发送日统计，只采用发送、受理、准备完成、开始执行、执行结束和最终送达时间全部齐全且有序的同一批记录。五段之和等于表中合计；与收到消息起算的交付耗时可能使用不同样本。',
      stages: '阶段为收到请求→开始运行、开始运行→运行结束、运行结束→最终正文全部送达。阶段只采用时间齐全且顺序有效的同一批记录，样本可能少于总耗时；运行结束不等于工作完成。',
      delivery: '普通会话人工飞书请求受理至最终正文全部成功送达；与普通首响采用相同来源分区。排除开场／进展，运行中追加输入、Web 和未取得最终回执者未纳入。完成运行不等于任务验收。' } };
}
