import { readBody, escapeHtml } from '../lib/utils.mjs';
import { requests } from './requests.mjs';
import { recordFeatureExecution, readFeatureObservations, readFeatureReviewStatus } from './feature-observation.mjs';
import { readKnowledgeObservations } from './knowledge-pilot.mjs';

export async function handleFeatureObservation({ req, res, pathname, parsedUrl, authSession, writeJson }) {
  if (pathname !== '/api/monitoring/feature-observations') return false;
  try {
    if (req.method === 'GET') {
      if (parsedUrl?.query?.sessionId && parsedUrl?.query?.requestId) {
        const record = await requests.byRequest(parsedUrl.query.sessionId, parsedUrl.query.requestId);
        writeJson(res, record ? 200 : 404, record ? {review:await readFeatureReviewStatus(record)} : {error:'Input not found'});
        return true;
      }
      const value = await readFeatureObservations();
      try {
        const knowledge = await readKnowledgeObservations();
        if (knowledge) value.trials.push(knowledge);
      } catch (error) { value.knowledgeError = error.message; }
      if (parsedUrl?.query?.view === '1') {
        const esc = escapeHtml;
        const states = {finished:'已提交核对回执',started:'已开始，未结束',no_record:'已结束，无自检执行回执',awaiting_review:'运行中，等待自检',awaiting_receipt:'等待原生接收回执',missing_request:'原请求缺失'};
        const body = value.trials.map(t => t.featureId === 'organization-knowledge'
          ? `<h2>${esc(t.name)}</h2><p>${esc(t.semantics)}</p><p>自然输入 ${t.admittedInputs}；安装验证 ${t.verification.inputs} 条，单独保留。</p><table><tr><th>原工作</th><th>正文读取 / 字符</th><th>效果自评</th><th>完整用时</th></tr>${t.inputRecords.map(r=>`<tr><td><a href="/?session=${encodeURIComponent(r.sessionId)}">原工作</a></td><td>${r.bodyReadCalls} / ${r.bodyChars}</td><td>${esc(JSON.stringify(r.effect || '未回报'))}</td><td>${r.completionMs ?? '未知'}</td></tr>`).join('')}</table><details><summary>读取版本、原文及事件记录（含安装验证）</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(t.records,null,2))}</pre></details>`
          : `<h2>${esc(t.name)}</h2><p>${esc(t.semantics)}</p><p>已启用输入 ${t.admittedInputs}；结束后无自检回执 ${t.noExecutionReceipt}。</p><table><tr><th>接纳时间</th><th>原工作</th><th>实际状态</th></tr>${t.inputRecords.map(r=>`<tr><td>${esc(new Date(r.at).toISOString())}</td><td><a href="/?session=${encodeURIComponent(r.sessionId)}">原工作</a></td><td>${esc(states[r.state])}</td></tr>`).join('')}</table><table><tr><th>原任务</th><th>Agent自报结果</th><th>检查项与事件引用</th><th>阶段Token</th></tr>${t.records.map(r => `<tr><td><a href="/?session=${encodeURIComponent(r.sessionId)}">原工作</a></td><td>${esc(r.outcome || '未结束')}</td><td>${esc(JSON.stringify(r.checks || []))}</td><td>${r.usage?.totalTokens ?? '未知'}</td></tr>`).join('')}</table>`).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>功能观察证据</title><style>body{font:16px/1.6 system-ui;margin:24px;max-width:1100px}td,th{padding:10px;border:1px solid #ddd;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}</style><h1>功能观察证据</h1>${body || '<p>尚未配置观察，不代表功能已运行。</p>'}</html>`);
      } else writeJson(res, 200, value);
      return true;
    }
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    const input = JSON.parse(await readBody(req, 32768) || '{}');
    if (Object.keys(input).some(k => !['runId','requestId','action','outcome','metrics','checks','explanation'].includes(k))) throw new Error('Unknown observation field');
    const root = /^run_[\w-]+$/.test(input.runId || '') ? await requests.byRunId(input.runId) : null;
    const record = root && typeof input.requestId === 'string' ? await requests.byRequest(root.sessionId, input.requestId) : root;
    if (!root || root.result || root.releasedAt || !record
      || (record.nativeDispatchRunId || record.runId) !== root.runId
      || record.result || record.releasedAt || (record.nativeDispatchRunId && record.nativeReceipt?.accepted !== true)
      || !record.options?.viewPersonId || !record.options?.initiatedByIdentityId
      || authSession?.authKind !== 'service' && authSession?.personId !== record.options.viewPersonId) {
      throw Object.assign(new Error('需要当前运行中已接受的本人输入'), { status: 403 });
    }
    writeJson(res, 200, { observation: await recordFeatureExecution(record, input) });
  } catch (error) { writeJson(res, error.status || 400, { error: error.message }); }
  return true;
}
