// A read-only projection of existing topic/work records, never a task ledger.
import {topicTextView} from './feishu-web-topic-text.mjs';
const time=value=>{const n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)&&n>0?n:null;};
export function personNames(people=[]){return new Map(people.flatMap(p=>(p.identities||[]).map(i=>[i.id,p.name||i.displayName||''])));}
export function boardTopic(s,{view,webThreadId,names=new Map()}={}){
 const t=s.conversation?.target||{},works=s.workAwareness?.works||[];
 const latest=[...works].sort((a,b)=>(time(b.updatedAt)||0)-(time(a.updatedAt)||0))[0];
 const active=works.some(w=>['active','paused','blocked'].includes(w.status))||s.workAwareness?.activeCount>0;
 // A stopped execution is not a completed task. New input after a completion
 // also invalidates that completion as the state of the current conversation.
 const lastUser=time(s.lastUserMessageAt),workDone=latest?.status==='completed'&&(!lastUser||lastUser<=(time(latest.updatedAt)||0));
 const done=!active&&(workDone||s.workflowState==='done');
 const live=view?.status||'idle';
 const state=live==='running'?'running':live==='waiting'||s.workflowState==='waiting_user'?'waiting':done?'done':live==='review'?'review':'idle';
 const initiator=names.get(s.initiatedByIdentityId)||works.find(w=>w.actor?.identityId===s.initiatedByIdentityId)?.actor?.name||'';
 const participants=[...new Set(works.map(w=>w.actor?.name).filter(Boolean))];
 return {sessionId:s.id,chatId:t.chatId,threadId:t.threadId,rootId:t.rootId||t.messageId,
  webThreadId:webThreadId||null,...topicTextView(s,{state:live}),state,
  completionSource:state==='done'?(workDone?'work-record':'session-workflow'):null,
  lastUserMessageAt:lastUser,initiator,participants,
  // Actor identifies who initiated the work record, not its assignee.
  personLabel:initiator?'发起人':'发起人待核',archived:!!s.archived,
  sourceStale:!!s.boardSourceStale,sourceUpdatedAt:s.updatedAt||'',sessionUrl:'https://index.jiujianian.dev/?session='+s.id+'&tab=sessions'};
}
export function boardGroups(board){
 const entries=Array.isArray(board.groups)?board.groups:[
  {chatId:board.workChatId,name:board.workChatName,role:'work'},
  {chatId:board.discussionChatId,name:board.discussionChatName,role:'discussion'}];
 const seen=new Set();
 return entries.filter(g=>typeof g?.chatId==='string'&&g.chatId&&!seen.has(g.chatId)&&seen.add(g.chatId))
  .map(g=>({chatId:g.chatId,name:g.name||g.chatId,role:g.role||'group'}));
}
export function verifiedBoards(boards,groups){
 return boards.flatMap(board=>{
  const all=boardGroups(board),verified=all.filter(g=>groups[g.chatId]);
  // Legacy pairs keep their all-or-nothing scope. Explicit group lists can
  // become available incrementally, but never expose an unverified group.
  if(!verified.length||(!Array.isArray(board.groups)&&verified.length!==all.length))return [];
  return [{...board,groups:verified}];
 });
}
export function buildGroupBoards(sessions,{pairs=[],groups={},names=new Map(),bindings={},viewFor}={}){
 return pairs.map(pair=>{
  const members=boardGroups(pair),chats=members.map(g=>g.chatId);
  const topics=[...sessions.values()].filter(s=>chats.includes(s.conversation?.target?.chatId)).map(s=>boardTopic(s,{view:viewFor(s),names,webThreadId:bindings[s.conversation?.target?.rootId||s.conversation?.target?.messageId]}));
  return {id:pair.id,name:pair.name,groups:members.map(g=>({...g,webChatId:groups[g.chatId]||null})),topics};
 });
}
