import { diagnosisKey } from './session-diagnosis.mjs';
import { metricLabels } from './metric-diagnosis.mjs';
import { alertTime, alertEvidenceImage, alertHistoryPanel } from './alert-card-history.mjs';

export const METRIC_MERGE_MS = 3 * 60 * 60000;
export const metricRecipientKey = c => diagnosisKey([c.profile,c.configDir,c.feishuAppId,c.openId]);

// Keep statistical incidents independent. Only their human-facing delivery is merged.
// An existing incident always updates its original card, even after the admission window.
export function metricAlertBundles(state, config, now) {
  const recipientKey = metricRecipientKey(config);
  const groups = state.metricNotifications ||= {};
  const incidents = Object.values(state.incidents).filter(i => i.kind === 'metric');
  const eligible = incidents.filter(i => i.notification?.ready);
  // Adopt a recent legacy receipt instead of creating yet another card during upgrade.
  if (!Object.keys(groups).length) {
    const legacy = incidents.filter(i => i.delivery?.messageId && i.delivery.recipientKey === recipientKey
      && now - Date.parse(i.diagnosedAt || i.updatedAt) < METRIC_MERGE_MS);
    if (legacy.length) {
      legacy.sort((a,b) => (b.diagnosedAt || b.updatedAt).localeCompare(a.diagnosedAt || a.updatedAt));
      const anchor = legacy[0], id = diagnosisKey(['metric-notice',anchor.delivery.messageId]);
      groups[id] = {id,kind:'metric-bundle',createdAt:anchor.diagnosedAt || anchor.updatedAt,
        recipientKey,memberIds:legacy.map(i=>i.id),delivery:{...anchor.delivery,version:null},migration:true};
    }
  }
  for (const item of eligible) {
    let group = Object.values(groups).find(g => g.recipientKey === recipientKey && g.memberIds.includes(item.id));
    if (!group) group = Object.values(groups).filter(g => g.recipientKey === recipientKey
      && now-Date.parse(g.createdAt) < METRIC_MERGE_MS).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    if (!group) {
      const id = diagnosisKey(['metric-notice',recipientKey,now]);
      group = groups[id] = {id,kind:'metric-bundle',createdAt:new Date(now).toISOString(),recipientKey,memberIds:[]};
    }
    if (!group.memberIds.includes(item.id)) group.memberIds.push(item.id);
  }
  return Object.values(groups).filter(g => g.recipientKey === recipientKey && (g.migration || g.memberIds.some(id=>state.incidents[id]?.notification?.ready)))
    .map(group => {
      group.items = group.memberIds.map(id=>state.incidents[id]).filter(Boolean).map(i=>({id:i.id,metric:i.metric,
        cohort:i.cohort,firstSessionRun:i.firstSessionRun,scope:i.scope,status:i.status,summary:i.summary,
        evidence:i.evidence,action:i.action,verification:i.verification,resolutionType:i.resolutionType,
        baselineRevisions:i.baselineRevisions,updatedAt:i.updatedAt}));
      group.status = group.items.every(i=>i.status==='resolved') ? 'resolved' : 'needs_review';
      return group;
    });
}

function scopeLabel(item) {
  let cohort = item.cohort;
  if (typeof cohort === 'string') { try { cohort = JSON.parse(cohort); } catch { cohort = null; } }
  if (Array.isArray(cohort)) return `同配置分组 · ${cohort[0]} / ${cohort[1]} · ${{first:'首轮',follow:'后续轮'}[cohort[4]] || '轮次未知'}`;
  return `总体 · ${item.firstSessionRun === true ? '首轮' : item.firstSessionRun === false ? '后续轮' : '轮次未知'}`;
}

export function metricBundleCard(group, config) {
  const resolved = group.status === 'resolved';
  const items = group.items || [];
  const corrected = items.some(i=>i.resolutionType==='baseline_recalibrated');
  const active = items.filter(i => i.status !== 'resolved');
  // Prefer population summaries for a compact overview, retaining every cohort
  // and its comparison window in the closed evidence panel below.
  const overview = (resolved ? items : active).filter(i => !i.cohort
    || !(resolved ? items : active).some(other => other.metric === i.metric && !other.cohort));
  const summaries = overview.map(i => `${metricLabels[i.metric] || i.metric}（${scopeLabel(i)}）：${i.summary}`);
  const evidence = items.map(i => `${metricLabels[i.metric] || i.metric}（${scopeLabel(i)}）${i.status === 'resolved' ? i.resolutionType==='baseline_recalibrated'?' · 基准已更正':' · 已恢复' : ''}\n${i.summary}\n${(i.evidence || []).join('\n')}`
    + (i.baselineRevisions?.length ? '\n更正前的原始依据：\n'+i.baselineRevisions.map(r=>`${alertTime(r.at)}：${r.summary}\n${(r.evidence||[]).join('\n')}`).join('\n') : ''));
  const clues = active.flatMap(i => (i.evidence || []).filter(e => e.includes('增长线索')))
    .flatMap(e => [...e.matchAll(/(?:增长线索：|；)([^；。]+?)(?:平均增加|约增加)([\d,]+)字符/g)])
    .map(m => ({name:m[1].replace(/^隐藏/, ''), chars:Number(m[2].replaceAll(',', ''))}))
    .sort((a,b) => b.chars-a.chars);
  const diagnosis = clues.length ? `增长主要集中在「${clues[0].name}」；是否导致响应变慢仍待验证。`
    : '统计异常已确认，原因尚未定位。';
  const status = resolved ? corrected?'已按新基准复核；基准更正不代表性能恢复。':'后续样本已达到恢复条件。'
    : group.handling?.summary || '已完成样本与增长来源检查；尚无修复完成的记录。';
  const history = items.map(i=>({at:i.updatedAt,label:metricLabels[i.metric],summary:[i.action,i.verification].filter(Boolean).join('；')}));
  return {config:{wide_screen_mode:true,update_multi:true},header:{title:{tag:'plain_text',content:`上下文与响应${resolved?corrected?' · 已复核':' · 已恢复':' · 异常待恢复'}`},template:resolved?'green':'orange'},
    elements:[{tag:'div',text:{tag:'plain_text',content:summaries.join('\n\n') || '暂无可展示的指标。'}},
      {tag:'div',text:{tag:'plain_text',content:(corrected?'部分原预警的比较基准已更正，原始证据保留在统计依据中。\n\n':'')+(resolved ? '' : `主要线索：${diagnosis}\n\n`) + `处理状态：${status}`}},
      ...alertEvidenceImage(group),
      {tag:'collapsible_panel',expanded:false,header:{title:{tag:'plain_text',content:`统计依据 · ${items.length}组（含同类任务比较）`}},
        elements:[{tag:'div',text:{tag:'plain_text',content:evidence.join('\n\n')}}]},
      ...alertHistoryPanel(history),
      {tag:'note',elements:[{tag:'plain_text',content:`${alertTime(group.createdAt)} 起，3 小时内新异常合并到本卡；已有问题持续原位更新。时间为北京时间。`}]},
      ...(config.overviewUrl?[{tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:'查看完整趋势与记录'},url:config.overviewUrl,type:'default'}]}]:[])]};
}
