import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'bounded-source-')); setIsolatedTestHome(home);
const { pageSourceContext, readSourcePage, freezeLargeSourceContext, hydrateSourceContext } = await import('../chat/source-context-pages.mjs');
const { projectFeishuContext } = await import('../chat/feishu-context-dedup.mjs');
const { buildSourceContextPrompt } = await import('../chat/source-context-prompt.mjs');
const { loadFeishuConversationContext } = await import('../connectors/feishu/conversation-context.mjs');
try {
  const long = '开头条件\n\n' + '长文😀\n代码 $() `保持原文`\n'.repeat(6000) + '\n最后条件：不得发布。';
  const original = [{ messageId:'a', text:long, sender:'Alice', parentId:'original' },
    { messageId:'b', text:'同意', sender:'Bob' }, { messageId:'c', text:'同意', sender:'Carol' }];
  const source = { connector:'feishu', chatType:'group', sourceRouteId:'fixture', chatId:'group', conversationContext:{ messages:original } };
  const frozen = await freezeLargeSourceContext('s',source);
  assert.ok(Buffer.byteLength(JSON.stringify(frozen)) < 2000);
  assert.deepEqual(await hydrateSourceContext('s',frozen),source,'transport archive preserves original source');
  await assert.rejects(hydrateSourceContext('other-session',frozen),/does not match/);
  assert.equal(await pageSourceContext('s',source),source,'group input never creates reading pages');
  const projected = await projectFeishuContext('s',frozen,{}, { page:async()=>assert.fail('group paging was removed') });
  assert.deepEqual(projected.sourceContext.conversationContext.messages.map(m=>m.messageId),['b','c']);
  assert.equal(projected.receipt.entries.length,2,'omitted messages do not get a read receipt');
  assert.equal(projected.sourceContext.conversationContext.pending,undefined);
  assert.doesNotMatch(buildSourceContextPrompt(projected.sourceContext),/nextCursor|逐页读完|本轮应阅读|source-context-pages/);
  assert.equal((await hydrateSourceContext('s',frozen)).conversationContext.messages[0].text,long);

  const longLast = { ...source, conversationContext:{ messages:[...original.slice(1),original[0]] } };
  const excerpt = await projectFeishuContext('s',longLast);
  assert.ok(excerpt.sourceContext.conversationContext.messages[0].text.length < 48000);
  assert.equal(excerpt.sourceContext.conversationContext.truncated,true);
  assert.equal(excerpt.receipt.entries.length,1);
  const failure = await projectFeishuContext('s',longLast, { identity:{field:'codexThreadId',id:'known'} },
    { history:async()=>{ throw Error('missing receipts'); } });
  assert.ok(failure.sourceContext.conversationContext.messages.reduce((sum,m)=>sum+m.text.length,0) < 48000,
    'receipt failure cannot expand group input');

  const now = Date.parse('2026-10-26T06:00:00Z');
  const many = Array.from({length:2440},(_,i)=>({messageId:String(i),text:'text'+i,sender:'Alice',timestamp:now-(2440-i)*60000}));
  const legacy = { ...source, createTime:String(now), conversationContext:{messages:many,
    coverage:{fetchedAllPages:true},pending:{path:'/old/archive',reader:'/old/reader',messageCount:2340}} };
  const recovered = await projectFeishuContext('s',await freezeLargeSourceContext('s',legacy));
  assert.equal(recovered.sourceContext.conversationContext.messages.length,100);
  assert.equal(recovered.sourceContext.conversationContext.messages[0].messageId,'2340');
  assert.equal(recovered.receipt.entries.length,100);
  assert.equal(recovered.sourceContext.conversationContext.pending,undefined);
  assert.equal(recovered.sourceContext.conversationContext.coverage,undefined);
  assert.doesNotMatch(buildSourceContextPrompt(legacy),/old\/archive|nextCursor|逐页读完/,'legacy group pointers are not reading tasks');
  const gap = await projectFeishuContext('s',{...source,createTime:String(now),conversationContext:{messages:[
    {...original[1],timestamp:now-6*3600000},{...original[2],timestamp:now-60000},
  ]}});
  assert.deepEqual(gap.sourceContext.conversationContext.messages.map(m=>m.messageId),['c'],'old snapshots also respect the activity gap');

  // Private conversations keep full paging and exact source reconstruction.
  const privateSource = {...source,chatType:'p2p'};
  const paged = await pageSourceContext('s',privateSource);
  assert.equal(paged.conversationContext.messages.length,0);
  const chunks = new Map(); let cursor='0:0', count=0;
  do {
    const page=await readSourcePage(paged.conversationContext.pending.path,cursor);
    chunks.set(page.message.messageId,(chunks.get(page.message.messageId)||'')+page.message.text);
    cursor=page.nextCursor; count++; assert.ok(count<200);
  } while(cursor);
  for(const item of original) assert.equal(chunks.get(item.messageId),item.text);
  assert.match(buildSourceContextPrompt(paged),/逐页读完/);
  const privateProjected = await projectFeishuContext('s',privateSource);
  assert.equal(privateProjected.receipt.entries.length,0,'unread private pages remain outside delivery receipts');
  const privateFailure = await projectFeishuContext('s',privateSource,{}, {page:async()=>{throw Error('disk unavailable');}});
  assert.match(buildSourceContextPrompt(privateFailure.sourceContext),/最后条件：不得发布/);

  const pages=[];
  const raw=many.slice(0,151).map((item,i)=>({message_id:item.messageId,create_time:String(1000000000000+i*86400000),
    msg_type:'text',sender:{sender_name:item.sender,sender_type:'user'},body:{content:JSON.stringify({text:i===75?long:item.text})},parent_id:'original'})).reverse();
  const runtime={appClient:{im:{v1:{message:{list:async({params})=>{pages.push(params);const offset=Number(params.page_token||0);
    return {code:0,data:{items:raw.slice(offset,offset+50),has_more:offset+50<raw.length,page_token:String(offset+50)}};}}}}}};
  const context=await loadFeishuConversationContext(runtime,{chatId:'private',chatType:'p2p',createTime:String(2000000000000),messageId:'now'}, {complete:true,includeMetadata:true});
  assert.equal(context.messages.length,151);
  assert.equal(context.messages[75].text,long); assert.equal(context.messages[75].parentId,'original');
  assert.equal(pages[0].end_time,'2000000001'); assert.equal(pages.length,4);
  assert.equal(pages[0].start_time,undefined); assert.equal(context.coverage.fetchedAllPages,true);
  await assert.rejects(loadFeishuConversationContext({}, {chatId:'private',chatType:'p2p'}, {complete:true}),/unavailable/);
  const broken={appClient:{im:{v1:{message:{list:async()=>({code:0,data:{items:raw.slice(0,50),has_more:true,page_token:'same'}})}}}}};
  await assert.rejects(loadFeishuConversationContext(broken,{chatId:'private',chatType:'p2p'}, {complete:true}),/pagination stopped/);
  console.log('Source context: bounded 2440-message legacy group replay, no group pages, activity gap, receipt-failure cap, immutable originals and unchanged private paging passed');
} finally { await rm(home,{recursive:true,force:true}); }
