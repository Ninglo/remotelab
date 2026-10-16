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
        evidence:i.evidence,action:i.action,verification:i.verification,updatedAt:i.updatedAt}));
      group.status = group.items.every(i=>i.status==='resolved') ? 'resolved' : 'needs_review';
      return group;
    });
}

export function metricBundleCard(group, config) {
  const resolved = group.status === 'resolved';
  const evidence = group.items.map(item => {
    const scope = Array.isArray(item.cohort) ? item.cohort : (()=>{try{return JSON.parse(item.cohort);}catch{return null;}})();
    const label = scope ? `同类任务 · ${scope[0]} / ${scope[1]} · ${scope[4]==='first'?'首轮':'后续轮'}`
      : `总体趋势 · ${item.firstSessionRun ? '首轮' : '后续轮'}`;
    return `${metricLabels[item.metric] || item.metric}（${label}）${item.status==='resolved'?' · 已恢复':''}\n${item.summary}\n`
      + (item.evidence || []).filter(e=>e.includes('增长线索')).join('\n');
  });
  const history = group.items.map(i=>({at:i.updatedAt,label:metricLabels[i.metric],summary:[i.action,i.verification].filter(Boolean).join('；')}));
  return {config:{wide_screen_mode:true,update_multi:true},header:{title:{tag:'plain_text',content:`上下文与响应监管${resolved?' · 已恢复':' · 预警'}`},template:resolved?'green':'orange'},
    elements:[...alertEvidenceImage(group),{tag:'div',text:{tag:'plain_text',content:
      `本卡合并起点：${alertTime(group.createdAt)}（北京时间）\n3 小时内的新指标预警合并到本卡；已有问题的变化继续原位更新。\n\n${evidence.join('\n\n')}\n\n`
      +(resolved?'后续样本已验证恢复；保留原始分析记录。':'已自动核对样本、实验构成和增长来源；处理记录见下方。')}} ,...alertHistoryPanel(history),
      ...(config.overviewUrl?[{tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:'查看清晰趋势与监管记录'},url:config.overviewUrl,type:'default'}]}]:[])]};
}
