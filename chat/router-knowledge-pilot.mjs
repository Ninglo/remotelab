import { readBody } from '../lib/utils.mjs';
import { requests } from './requests.mjs';
import { queryKnowledge } from './knowledge-pilot.mjs';

export async function handleKnowledgePilot({req,res,pathname,authSession,writeJson}) {
  if (pathname !== '/api/knowledge-pilot') return false;
  try {
    if (req.method !== 'POST') {writeJson(res,405,{error:'Use POST'});return true;}
    const input=JSON.parse(await readBody(req,16384) || '{}');
    if (Object.keys(input).some(k=>!['runId','requestId','action','page','query','report','operationId'].includes(k))) throw new Error('Unknown knowledge field');
    const root=/^run_[\w-]+$/.test(input.runId || '') ? await requests.byRunId(input.runId) : null;
    const record=root && typeof input.requestId==='string' ? await requests.byRequest(root.sessionId,input.requestId) : root;
    if (!root || root.result || root.releasedAt || !record || record.result || record.releasedAt
      || (record.nativeDispatchRunId || record.runId) !== root.runId
      || record.nativeDispatchRunId && record.nativeReceipt?.accepted !== true
      || !record.options?.viewPersonId || !record.options?.initiatedByIdentityId
      || authSession?.authKind !== 'service' && authSession?.personId !== record.options.viewPersonId) {
      throw Object.assign(new Error('需要当前运行中已接受的本人输入'),{status:403});
    }
    writeJson(res,200,await queryKnowledge(record,input));
  } catch(e) {writeJson(res,e.status || 400,{error:e.message});}
  return true;
}
