import { createHash, randomUUID } from 'node:crypto';
import { readBody } from '../lib/utils.mjs';
import { runtimeHrPolicy, resolveHrActor, authorizeHr, hrScopes, refreshRuntimeHrPolicy } from '../lib/hr-policy.mjs';
import { queryHrService } from '../lib/hr-policy-client.mjs';
import { requests } from './requests.mjs';

export function hrManagementActor(auth, record, current) {
  if (!current?.policy) return null;
  let options;
  if (auth?.authKind === 'service') {
    if (!record || record.result || record.options?.internalOperation || record.options?.deliveryOnly) return null;
    options = record.options;
  } else {
    if (!auth?.personId || !auth?.identityId) return null;
    options = {viewPersonId:auth.personId, initiatedByIdentityId:auth.identityId};
  }
  return resolveHrActor(current.policy, options, current.instance);
}

export async function handleHrAccessRoutes({req, res, pathname, authSession, writeJson}) {
  if (!['/api/hr-access/policy','/api/hr-access/feedback'].includes(pathname)) return false;
  if (req.method !== 'POST') { writeJson(res,405,{error:'POST required'}); return true; }
  try {
    const input = JSON.parse(await readBody(req,32*1024));
    if (Object.keys(input).some(k => !['runId','change','feedback'].includes(k))) throw new Error('Invalid fields');
    const current = runtimeHrPolicy();
    const record = typeof input.runId === 'string' ? await requests.byRunId(input.runId) : null;
    const actor = hrManagementActor(authSession,record,current);
    if (pathname === '/api/hr-access/feedback') {
      if (!actor || !hrScopes(current.policy,actor,'feedback.write').length || !input.feedback || input.change) {
        writeJson(res,403,{error:'当前身份不能提交面评'}); return true;
      }
      const {candidateId,...feedback}=input.feedback;
      const messageId=record ? record.requestId : `web:${randomUUID()}`;
      const result=await queryHrService(current.registry,{action:'feedback',candidateId,feedback},actor,{messageId});
      writeJson(res,200,result); return true;
    }
    if (!actor || !actor.owner && !authorizeHr(current.policy,actor,'policy.roles')) {
      writeJson(res,403,{error:'只有一级权限可以管理角色和资料范围'}); return true;
    }
    if (!input.change) { writeJson(res,200,{policy:current.policy}); return true; }
    const action = {add:'users.add',remove:'users.remove',bind:'users.add',roles:'policy.roles',scope:'policy.scope'}[input.change.action];
    if (!action || !authorizeHr(current.policy,actor,action)) {
      writeJson(res,403,{error:'新增、移除使用者或补充身份绑定仅限当麻所有者'}); return true;
    }
    // Attribution always comes from a server-held accepted request or the
    // authenticated personal browser. An arbitrary actor in JSON is rejected.
    const requestRef = record ? `${current.instance}:${record.runId}:${createHash('sha256').update(JSON.stringify(input.change)).digest('hex').slice(0,16)}` : `web:${randomUUID()}`;
    const result = await queryHrService(current.registry,{action:'policy_change',question:'manage HR access',
      change:{...input.change,requestRef}},actor,{messageId:requestRef});
    await refreshRuntimeHrPolicy();
    writeJson(res,200,result);
  } catch { writeJson(res,409,{error:'权限修改未完成，请重新读取版本并检查角色、身份、范围及理由'}); }
  return true;
}
