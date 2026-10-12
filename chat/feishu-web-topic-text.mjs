// Display existing metadata while a new topic's generated name/description
// is still absent. A work goal is a recorded source, not a generated summary.
const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
export const placeholderSummary=value=>!clean(value)||/^inbounds?\s+feishu\b/i.test(clean(value));
export const placeholderName=value=>!clean(value)||/^【飞书(?:群|话题)?消息[｜|]/.test(clean(value))||/^(?:新会话|未命名话题|Untitled|New session)$/i.test(clean(value));
export function topicTextView(session,{state='idle'}={}){
 const goal=[...(session.workAwareness?.works||[])].sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0)).map(w=>clean(w.goal)).find(Boolean)||'';
 const named=!placeholderName(session.name),described=!placeholderSummary(session.description);
 return {name:named?clean(session.name):goal||'新话题',
  summary:described?clean(session.description):goal||(state==='running'?'正在处理，摘要生成中':'暂无摘要'),
  textSource:described?'session-description':goal?'work-goal':'pending-description'};
}
