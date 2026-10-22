import { readBody, escapeHtml } from '../lib/utils.mjs';
import { requests } from './requests.mjs';
import { recordFeatureExecution, readFeatureObservations } from './feature-observation.mjs';

export async function handleFeatureObservation({ req, res, pathname, parsedUrl, authSession, writeJson }) {
  if (pathname !== '/api/monitoring/feature-observations') return false;
  try {
    if (req.method === 'GET') {
      const value = await readFeatureObservations();
      if (parsedUrl?.query?.view === '1') {
        const esc = escapeHtml;
        const body = value.trials.map(t => `<h2>${esc(t.name)}</h2><p>${esc(t.semantics)}</p><table><tr><th>原任务</th><th>Agent自报结果</th><th>检查项与事件引用</th><th>阶段Token</th></tr>${t.records.map(r => `<tr><td><a href="/?session=${encodeURIComponent(r.sessionId)}">原工作</a></td><td>${esc(r.outcome || '未结束')}</td><td>${esc(JSON.stringify(r.checks || []))}</td><td>${r.usage?.totalTokens ?? '未知'}</td></tr>`).join('')}</table>`).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>功能观察证据</title><style>body{font:16px/1.6 system-ui;margin:24px;max-width:1100px}td,th{padding:10px;border:1px solid #ddd;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}</style><h1>功能观察证据</h1>${body || '<p>尚未配置观察，不代表功能已运行。</p>'}</html>`);
      } else writeJson(res, 200, value);
      return true;
    }
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    const input = JSON.parse(await readBody(req, 32768) || '{}');
    if (Object.keys(input).some(k => !['runId','requestId','action','outcome','metrics','checks'].includes(k))) throw new Error('Unknown observation field');
    const root = /^run_[\w-]+$/.test(input.runId || '') ? await requests.byRunId(input.runId) : null;
    const record = root && typeof input.requestId === 'string' ? await requests.byRequest(root.sessionId, input.requestId) : root;
    if (!root || root.result || root.releasedAt || !record
      || (record.nativeDispatchRunId || record.runId) !== root.runId
      || !record.options?.viewPersonId || !record.options?.initiatedByIdentityId
      || authSession?.authKind !== 'service' && authSession?.personId !== record.options.viewPersonId) {
      throw Object.assign(new Error('需要当前运行中已接受的本人输入'), { status: 403 });
    }
    writeJson(res, 200, { observation: await recordFeatureExecution(record, input) });
  } catch (error) { writeJson(res, error.status || 400, { error: error.message }); }
  return true;
}
