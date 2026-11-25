import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { refreshRuntimeHrPolicy, runtimeHrPolicy, hrScopes } from '../../lib/hr-policy.mjs';
import { summarizeFeishuCardAction, feishuHrActor } from './restricted-access.mjs';

// Narrow business callback lane; never admit interviewers to the agent executor.
// The business handler binds recipient/message and the backend rechecks own-write.
export function scorecardSummary(config, raw) {
  const event = raw?.event || raw;
  if (!String(event?.action?.name || '').startsWith('pretrain_')) return null;
  const openId = event?.operator?.operator_id?.open_id || event?.operator?.open_id;
  const summary = summarizeFeishuCardAction(config, raw, {sender:{openId}});
  const messageId = event?.context?.open_message_id, chatId = event?.context?.open_chat_id, action = event?.action;
  if (!summary || !/^om_[a-zA-Z0-9]+$/.test(messageId || '') || !/^oc_[a-zA-Z0-9]+$/.test(chatId || '')
      || action?.tag !== 'button' || !/^pretrain_(?:submit|rate_[a-z_]+_[0-5])$/.test(action.name)
      || !action.form_value || Array.isArray(action.form_value) || typeof action.form_value !== 'object'
      || JSON.stringify(action.form_value).length > 10000) throw new Error('Invalid scorecard callback');
  const eventId = raw?.header?.event_id || event?.event_id || event?.token;
  if (typeof eventId !== 'string' || !eventId) throw new Error('Missing scorecard callback ID');
  return {...summary, sourceKind:'interview_scorecard',eventType:'card.action.trigger',
    chatId,chatType:'p2p',messageId,action:{name:action.name,form_value:action.form_value},
    callbackId:createHash('sha256').update(eventId).digest('hex')};
}
async function permitted(runtime, summary, refresh=true) {
  if (runtime.config.accessPolicy?.roles?.hrPolicy !== true
      || !runtime.config.accessPolicy.roles.scorecardWorkflowCommand) return false;
  if (refresh) await refreshRuntimeHrPolicy();
  const actor=feishuHrActor(runtime.config.accessPolicy,summary), current=runtimeHrPolicy();
  return !!current && hrScopes(current.policy,actor,'candidate.read').length > 0
    && hrScopes(current.policy,actor,'feedback.write').length > 0;
}
export async function acceptInterviewScorecard(runtime, raw, inbox) {
  if (!String((raw?.event || raw)?.action?.name || '').startsWith('pretrain_')) return null;
  try {
    const summary=scorecardSummary(runtime.config,raw);
    if (!await permitted(runtime,summary,false)) return {toast:{type:'error',content:'当前身份没有面评填写权限。'}};
    await inbox.accept('scorecard:'+summary.callbackId,{summary,sourceLabel:'card.action.trigger'});
    return {toast:{type:'info',content:summary.action.name==='pretrain_submit'?'正在提交面评…':'正在保存选择…'}};
  } catch {
    return {toast:{type:'error',content:'面评操作未接收，请稍后重试。'}};
  }
}
export async function processInterviewScorecard(runtime, summary) {
  if (!await permitted(runtime,summary)) return {blocked:true};
  const command=runtime.config.accessPolicy.roles.scorecardWorkflowCommand;
  return new Promise((resolve,reject)=>{
    const child=spawn(command[0],command.slice(1),{stdio:['pipe','pipe','pipe'],shell:false});
    let out='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(new Error('Scorecard executor timed out'));},90000);
    child.stdout.on('data',bytes=>{out+=bytes;if(out.length>16000){child.kill('SIGTERM');finish(new Error('Scorecard receipt too large'));}});
    child.stderr.resume();child.stdin.on('error',error=>finish(error));child.on('error',error=>finish(error));
    child.on('close',code=>{
      if(code!==0)return finish(new Error('Scorecard executor failed; durable receipt retained'));
      try{const result=JSON.parse(out);if(result?.handled!==true)throw new Error('Invalid scorecard receipt');finish(null,result);}
      catch(error){finish(error);}
    });
    child.stdin.end(JSON.stringify({version:1,...summary}));
  });
}
