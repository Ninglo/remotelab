import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runNativeHost } from '../chat/native-host.mjs';
import { submitNativeInput } from '../chat/native-input-transport.mjs';

const directory = await fs.mkdtemp(join(tmpdir(), 'native-review-settlement-'));
const command = join(directory, 'peer.cjs');
await fs.writeFile(command, `#!/usr/bin/env node
const lines = require('node:readline').createInterface({input: process.stdin});
const emit = message => console.log(JSON.stringify(message));
let turns = 0;
lines.on('line', line => {
  const {id, method} = JSON.parse(line);
  if (method === 'initialize') emit({id, result:{}});
  if (method === 'thread/start') emit({id, result:{thread:{id:'thread'}}});
  if (method === 'turn/start') {
    if (++turns === 1) emit({id,result:{turn:{id:'turn',status:'inProgress'}}});
    else emit({id,error:{code:-32602,message:'New input rejected'}});
  }
  if (method === 'review/complete') emit({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
});
lines.on('close', () => process.exit(0));
`, { mode: 0o755 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const ready = deferred();
const terminal = deferred();
let proc;
let intercepted = false;
const originalOpen = fs.open;
// Hold the durable transport claim across the native terminal event. This is
// the real ordering possible when fsync overlaps a model completion callback.
fs.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (!intercepted && args[0] === join(directory, 'native-inputs') && args[1] === 'r') {
    intercepted = true;
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      proc.stdin.write(JSON.stringify({ method: 'review/complete' }) + '\n');
      await terminal.promise;
      await sync();
    };
  }
  return handle;
};
syncBuiltinESMExports();
let completed = false;
const hosted = runNativeHost({ directory, command, runtimeFamily: 'codex-json', options: {}, prompt: 'first',
  cwd: directory, env: { PATH: process.env.PATH },
  onProcess: async child => { proc = child; },
  onStdout: async line => {
    const event = JSON.parse(line);
    if (event.type === 'turn.started') ready.resolve();
    if (event.type === 'turn.completed') terminal.resolve();
  },
  onStderr: async () => {},
}).then(result => { completed = true; return result; });
try {
  await ready.promise;
  await assert.rejects(submitNativeInput(directory, { id: 'late', text: 'rejected continuation' }), { code: 'NATIVE_REJECTED' });
  await Promise.race([hosted, new Promise(resolve => setTimeout(resolve, 250))]);
  assert.equal(completed, true, 'a rejected late input must not erase the already completed native turn');
  assert.equal((await hosted).code, 0);
  console.log('native host settlement: a late rejected input preserves the prior completed turn');
} finally {
  fs.open = originalOpen; syncBuiltinESMExports();
  terminal.resolve();
  proc?.kill('SIGKILL');
  await hosted;
  await fs.rm(directory, { recursive: true, force: true });
}

// An ordinary follow-up can supply the missing detail without answering the
// old card. A completed final must then retire that card and stop the host.
for (const [finalImmediately, supersedeQuestions] of [[false, false], [true, false], [false, true]]) {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-question-final-'));
  const peer = join(root, 'peer.cjs');
  await fs.writeFile(peer, `#!/usr/bin/env node
const lines = require('node:readline').createInterface({input:process.stdin});
const emit = value => console.log(JSON.stringify(value));
const immediate = ${finalImmediately};
let turns = 0;
lines.on('line', line => {
  const {id, method} = JSON.parse(line);
  if(method === 'initialize') emit({id,result:{}});
  if(method === 'thread/start') emit({id,result:{thread:{id:'thread'}}});
  if(method === 'turn/start') {
    const turnId = 'turn-'+(++turns);
    emit({id,result:{turn:{id:turnId,status:'inProgress'}}});
    const item = turns === 1
      ? {id:'question',type:'agentMessage',delivery:'async',phase:'final_answer',questions:[{title:'More details?'}]}
      : {id:'final',type:'agentMessage',phase:'final_answer',text:'Completed with the ordinary follow-up.'};
    emit({method:'item/completed',params:{threadId:'thread',turnId,item}});
    if(immediate && turns === 1) emit({method:'item/completed',params:{threadId:'thread',turnId,item:{id:'same-turn-final',type:'agentMessage',phase:'final_answer',text:'Completed with an optional question.'}}});
    emit({method:'turn/completed',params:{threadId:'thread',turn:{id:turnId,status:'completed'}}});
  }
});
lines.on('close',()=>process.exit(0));
`, {mode:0o755});
  const asked = deferred();
  const initialCompleted = deferred();
  const events = [];
  let child, deadline;
  const hosted = runNativeHost({directory:root,command:peer,runtimeFamily:'codex-json',options:{},prompt:'initial',cwd:root,
    env:{PATH:process.env.PATH}, onProcess:async value=>{child=value;},
    onStdout:async line=>{const event=JSON.parse(line);events.push(event);if(event.type==='remotelab.user_question'&&event.state==='pending')asked.resolve();if(event.type==='turn.completed')initialCompleted.resolve();},
    onStderr:async()=>{},
  });
  try {
    if (!finalImmediately) {
      await asked.promise;
      // This fixture models a new turn after an async question, not turn/steer.
      // Seeing the card does not prove the first turn has emitted completion.
      await initialCompleted.promise;
      const receipt = await submitNativeInput(root,{id:'ordinary-follow-up',text:'Here are the details; finish.', ...(supersedeQuestions ? { supersedeQuestions: true } : {})});
      assert.equal(receipt.accepted,true);
    }
    const result = await Promise.race([hosted,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Completed final remained held by old question')),2000);})]);
    assert.equal(result.code,0);
    // A same-turn final may cancel the queued question before showNext runs.
    // That case has a durable journal but no visible pending card or pointer.
    const journalFiles = await fs.readdir(join(root,'native-questions'));
    assert.equal(journalFiles.length,1);
    const journal = JSON.parse(await fs.readFile(join(root,'native-questions',journalFiles[0]),'utf8'));
    assert.equal(journal.state,supersedeQuestions?'superseded':'cancelled','old question is retired');
    assert.deepEqual(journal.answers,{},'cancellation cannot invent an answer');
    if (events.some(event=>event.type==='remotelab.user_question'&&event.state==='pending')) {
      const question=JSON.parse(await fs.readFile(join(root,'native-question.json'),'utf8'));
      assert.equal(question.state,supersedeQuestions?'superseded':'cancelled','a visible question must also retire its current pointer');
      assert.ok(events.some(event=>event.type==='remotelab.user_question'&&event.state===(supersedeQuestions?'superseded':'cancelled')));
    }
    assert.equal(events.filter(event=>event.type==='turn.started').length,finalImmediately?1:2,'retiring the card cannot start another model turn');
    assert.ok(events.some(event=>event.type==='item.completed'&&event.item?.phase==='final_answer'
      && event.item.id===(finalImmediately?'same-turn-final':'final')), 'the actual final answer must arrive, not only the question');
    console.log('native host settlement: completed final retires an obsolete async question');
  } finally {
    clearTimeout(deadline);child?.kill('SIGKILL');await hosted;await fs.rm(root,{recursive:true,force:true});
  }
}

// Claude's queue receipt releases the blocking tool before the next user turn
// is consumed. No default answer or extra user input is manufactured.
{
  const root = await fs.mkdtemp(join(tmpdir(), 'claude-question-continuation-'));
  const peer = join(root, 'peer.cjs');
  await fs.writeFile(peer, `#!/usr/bin/env node
const lines = require('node:readline').createInterface({input:process.stdin});
const emit = value => console.log(JSON.stringify(value));
const users = [];
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'user') {
    users.push(message.uuid);
    emit({type:'command_lifecycle',command_uuid:message.uuid,state:'queued'});
    if (users.length === 1) emit({type:'control_request',request_id:'question',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',
      input:{questions:[{question:'Approve?',options:[{label:'Yes'},{label:'No'}]}]}}});
  }
  if (message.type === 'control_response') {
    const answers = message.response.response.updatedInput.answers;
    if (Object.keys(answers).length) process.exit(9);
    emit({type:'result',subtype:'success',user_message_uuids:users,result:'continued',queued_turn_count:0});
  }
});
lines.on('close',()=>process.exit(0));
`, {mode:0o755});
  const asked = deferred();
  const events = [];
  let child, deadline;
  const hosted = runNativeHost({directory:root,command:peer,runtimeFamily:'claude-stream-json',options:{},prompt:'initial',cwd:root,
    env:{PATH:process.env.PATH},onProcess:async value=>{child=value;},
    onStdout:async line=>{const event=JSON.parse(line);events.push(event);if(event.type==='remotelab.user_question'&&event.state==='pending')asked.resolve();},
    onStderr:async()=>{},
  });
  try {
    await asked.promise;
    assert.equal((await submitNativeInput(root,{id:'human',text:'I have a different requirement',supersedeQuestions:true})).accepted,true);
    const result = await Promise.race([hosted,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Claude question held its accepted continuation')),2000);})]);
    assert.equal(result.code,0);
    assert.ok(events.some(event=>event.type==='remotelab.user_question'&&event.state==='superseded'));
    assert.equal(events.some(event=>event.type==='remotelab.user_question'&&event.state==='answered'),false);
    console.log('native host continuation: Claude releases its question without inventing consent');
  } finally {
    clearTimeout(deadline);child?.kill('SIGKILL');await hosted;await fs.rm(root,{recursive:true,force:true});
  }
}
