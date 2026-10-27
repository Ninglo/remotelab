// Synthetic Feishu contract backed by React 17: no network or real account.
import React from 'react';
import ReactDOM from 'react-dom';
window.__fixture={selected:null,context:null,loads:0};
const base=1000000000000000000n;
const id=n=>String(base+BigInt(n));
const previews=Object.fromEntries(Array.from({length:180},(_,i)=>[id(i+1),{type:i%7===0?1:4,entityType:1,chatType:i%7===0?1:2,isP2P:i%7===0,chatId:id(900+i%3),displayTime:10000-i,onTopRankTime:i===0?1:0}]));
const records=Object.keys(previews).map((id,i)=>({id,bizId:id,isPreviewKind:true,tempTopPos:i===0?'orphan':undefined}));
window.__fixture.records=records;
const initialCursor={id:'2',rankTime:'3'};
let state={status:{activeFilterItemId:'threads'},threads:{type:'threads',inited:true,list:{feedCursor:initialCursor}}};
window.__feedStore={getState:()=>state};
const factories={},cache={};
function require(id){if(id==='react')return React;if(!cache[id]){const m={exports:{}};cache[id]=m;factories[id](m,m.exports,require);}return cache[id].exports;}
const queue=window.webpackChunkLarkletMessenger=window.webpackChunkLarkletMessenger||[];
const before=queue.push.bind(queue);
queue.push=function(chunk){Object.assign(factories,chunk[1]);return before(chunk);};
queue.push([[1],{feed:function(module,exports,require){
 const R=require('react');
 const Feed=R.forwardRef(function(props,ref){
   const [start,setStart]=R.useState(0);
   const list=props.list;
   return R.createElement('div',{className:'feed-main-list',ref,tabIndex:0,onScroll:e=>setStart(Math.floor(e.currentTarget.scrollTop/68)),onKeyDown:e=>{if(e.key==='ArrowDown'){const n=list.findIndex(x=>x.id===window.__fixture.selected);window.__fixture.selected=list[n+1]?.id;}}},R.createElement('div',{style:{height:list.length*68,position:'relative'}},list.slice(start,start+13).map((row,n)=>R.createElement('div',{key:row.id,'data-feed-id':row.id,style:{position:'absolute',top:(start+n)*68,height:68,width:'100%'},onClick:()=>{window.__fixture.selected=row.id;},onContextMenu:e=>{e.preventDefault();window.__fixture.context=row.id;}},
      R.createElement('div',{className:'avatar'},'头像'),R.createElement('div',{className:'a11y_feed_card_main'},R.createElement('div',{className:'_2b17aec6'},'原生话题 '+row.id.slice(-3)),R.createElement('div',{className:'_5d806a78'},'飞书消息预览 '+row.id.slice(-3)),R.createElement('span',{className:'_3766bee7'},'09:20'))))));
 });Feed.displayName='[Render] FeedList';module.exports=R.memo(Feed);
}}]);
const Feed=require('feed');
function App(){const [limit,setLimit]=React.useState(35),[filter,setFilter]=React.useState('threads');
 const loadmore=React.useCallback(()=>{window.__fixture.loads++;return new Promise(resolve=>setTimeout(()=>{state.threads.list.feedCursor={id:'0',rankTime:'0'};setLimit(180);resolve();},70));},[]);
 const getPreviewById=React.useCallback(id=>previews[id],[]);
 const list=React.useMemo(()=>filter==='threads'?records.slice(0,limit):records.slice(0,limit).reverse(),[filter,limit]);
 return <><aside className="appNavbar"><div className="appNavbar-navbarMenu"><div className="navbarMenu"><span className="navbarMenu-icon">▣</span><span className="navbarMenu-content">消息</span></div><div className="navbarMenu"><span className="navbarMenu-icon">▤</span><span className="navbarMenu-content">日历</span></div></div></aside><div className="page-view-messenger"><aside className="a11y_feed_filter_list"><div className="native-group-scroll"><button onClick={()=>setFilter('threads')}>话题</button><button onClick={()=>setFilter('all')}>全部</button><button>未读</button><button>已完成</button></div></aside><section className="feed-column _01cd2079"><header className="_79e103ba">消息 <span>原生群筛选</span></header><div className="native-list-wrapper"><Feed list={list} filterId="threads" getPreviewById={getPreviewById} loadmore={loadmore}/></div></section></div><main className="lark-chat"><textarea defaultValue="原生草稿保持不变"/></main></>;
}
ReactDOM.render(<App/>,document.getElementById('app'));
