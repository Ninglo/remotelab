import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordStore } from '../lib/durable-records.mjs';
import { queryRestrictedInterview } from '../connectors/feishu/restricted-access.mjs';

const dir = await mkdtemp(join(tmpdir(),'interview-conversation-'));
try {
  const credentialsPath=join(dir,'credentials.json');
  await writeFile(credentialsPath,JSON.stringify({apiKey:'fixture',signingKey:'fixture'}));
  const policy={mode:'roles',roles:{appId:'cli_test',tenantKey:'tenant',hrOpenIds:['ou_hr'],
    interviewerOpenIds:['ou_a','ou_b'],endpoint:'https://example.invalid/query',credentialsPath}};
  const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
  const base={appId:'cli_test',tenantKey:'tenant',chatId:'oc_a',chatType:'p2p',messageType:'text',
    eventType:'im.message.receive_v1',sender:{openId:'ou_a',senderType:'user',tenantKey:'tenant'}};
  let stamp=1000;
  let selected=ids[0];
  const seen=[];
  const fetchImpl=async(url,options)=>{
    assert.equal(url,policy.roles.endpoint);
    const p=JSON.parse(options.body); seen.push(p);
    if(p.query.action==='chat')return {ok:true,json:async()=>({nextQuery:{action:'answer',
      candidateIds:[selected],question:p.query.question}})};
    return {ok:true,json:async()=>({text:'authorized answer',candidateIds:p.query.candidateIds})};
  };
  const run=async(event,extra={})=>queryRestrictedInterview(policy,{...base,...event},
    {fetchImpl,now:()=>++stamp,store:createRecordStore(join(dir,'context')),...extra});
  const first={messageId:'one',messageText:'我的候选人 侯云浩，一面和二面的反馈是什么？'};
  await run(first);
  assert.equal(seen.length,2); assert.equal(seen[0].query.context,undefined);
  assert.equal(seen[1].query.action,'answer');
  await run({messageId:'two',messageText:'那他下一轮重点问什么？'});
  assert.deepEqual(seen[2].query.context.candidateIds,[ids[0]]);
  assert.equal(seen[2].query.context.question,first.messageText);
  selected=ids[1];
  await run({messageId:'three',messageText:'看看另外一位候选人乙'});
  await run(first); // delivery replay keeps the first resolved candidate after restart
  assert.equal(seen.at(-1).query.action,'answer');
  assert.deepEqual(seen.at(-1).query.candidateIds,[ids[0]]);
  await run({messageId:'four',messageText:'他的面评呢'});
  assert.deepEqual(seen.at(-2).query.context.candidateIds,[ids[1]],'old delivery cannot roll back context');
  await run({messageId:'five',messageText:'他呢',chatId:'oc_other'});
  assert.equal(seen.at(-2).query.context,undefined);
  await run({messageId:'six',messageText:'他呢',sender:{...base.sender,openId:'ou_b'}});
  assert.equal(seen.at(-2).query.context,undefined);
  await assert.rejects(run({messageId:'invalid',messageText:'query'}, {fetchImpl:async()=>({ok:true,
    json:async()=>({nextQuery:{action:'execute',url:'https://other.invalid'}})})}));
  assert.equal(await run({messageId:'revoked',messageText:'他呢'}, {fetchImpl:async()=>({ok:true,
    json:async()=>({text:'access denied',candidateIds:[]})})}),'access denied');
  console.log('PASS: natural query resolution, restart, followup, subject/chat isolation, replay, revocation and closed endpoint protocol');
} finally {await rm(dir,{recursive:true,force:true});}
