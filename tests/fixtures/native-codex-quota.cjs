#!/usr/bin/env node
const readline = require('node:readline');
const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
const limits = () => ({rateLimits:{primary:{
  usedPercent:95, windowDurationMins:10080, resetsAt:Math.floor(Date.now()/1000)+86400,
}}});
const finish = () => {
  const threadId='quota-background-thread';
  emit({method:'item/completed',params:{threadId,turnId:'quota-turn',
    item:{id:'answer',type:'agentMessage',text:'QUOTA_INDEPENDENT',phase:'final_answer'}}});
  emit({method:'turn/completed',params:{threadId,turn:{id:'quota-turn',status:'completed'}}});
};
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  let result;
  if (message.method === 'initialized') return;
  if (message.method === 'initialize') result = {};
  else if (message.method === 'account/read') result = {account:{type:'chatgpt',planType:'pro'}};
  else if (message.method === 'account/rateLimits/read') result = limits();
  else if (message.method === 'thread/start' || message.method === 'thread/resume')
    result = {thread:{id:'quota-background-thread'}};
  else if (message.method === 'turn/start') {
    result = {turn:{id:'quota-turn',status:'inProgress'}};
    setImmediate(() => {
      emit({method:'account/rateLimits/updated',params:limits()});
      if (!process.env.QUOTA_FIXTURE_HOLD) finish();
    });
  } else if (message.method === 'turn/steer') {
    result={turnId:'quota-turn'};
    setImmediate(finish);
  } else throw new Error('Unexpected synthetic method: ' + message.method);
  emit({id:message.id,result});
});
