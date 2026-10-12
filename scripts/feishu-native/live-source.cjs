// Reuse the already-authorized Mac Web Live projection. No RemoteLab login
// grant, cookies or service credentials are read or manufactured here.
const fs=require('node:fs'),path=require('node:path');
async function browserAccount(){
 const pages=await(await fetch('http://127.0.0.1:19323/json/list',{signal:AbortSignal.timeout(3000)})).json();
 const page=pages.find(p=>p.type==='page'&&p.url?.startsWith('https://qcnatfwzm13g.feishu.cn/next/messenger/')&&!p.url.includes('rlfe-discovery'));
 if(!page)throw Error('原已授权飞书窗口未连接');
 const WebSocket=require('/Users/jiujianian/code/remotelab/node_modules/ws');
 return new Promise((resolve,reject)=>{const ws=new WebSocket(page.webSocketDebuggerUrl),timer=setTimeout(()=>finish(Error('来源账号读取超时')),3000);
  function finish(error,value){clearTimeout(timer);ws.removeAllListeners();ws.on('error',()=>{});ws.close();error?reject(error):resolve(value);}
  ws.once('error',e=>finish(e));ws.once('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'String(globalThis.userId || document.documentElement.dataset.rlfeAccountId || "")',returnByValue:true}})));
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id===1)finish(null,m.result?.result?.value||'');});
 });
}
function createLiveSource({root,web,onChange,readAccount=browserAccount,alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}},interval=15000}){
 let current={entries:[],boards:[],sourceConnected:false},identity='',busy=false,again=false,stopped=false,last='';
 const read=name=>JSON.parse(fs.readFileSync(path.join(web,name),'utf8'));
 const binding=()=>JSON.parse(fs.readFileSync(path.join(root,'native-source-account.json'),'utf8')).account;
 async function refresh(){
  if(stopped)return;if(busy){again=true;return;}busy=true;
  try{
   const expected=binding(),account=await readAccount();
   if(!/^\d{10,30}$/.test(expected)||account!==expected){identity='';current={entries:[],boards:[],sourceConnected:false,error:'本机来源账号已变化，状态未同步'};}
   else{identity=account;const data=read('topic-projection.json'),status=read('live-status.json');
    if(!Array.isArray(data.entries)||!Array.isArray(data.boards))throw Error('本机状态来源格式无效');
    // The existing controller owns the upstream 45-second heartbeat lease.
    // Its death must also invalidate the last on-disk connected flag.
    const connected=data.sourceConnected===true&&status.upstreamConnected===true&&status.connected===true&&alive(status.pid);
    const older=Date.parse(data.syncedAt)<Date.parse(current.syncedAt);
    current={...(older?current:data),sourceConnected:connected&&!older,error:connected&&!older?'':'来源连接中断，当前状态未知'};
   }
  }catch(e){current={...current,sourceConnected:false,error:e.message};}
  finally{busy=false;const digest=JSON.stringify([identity,current]);if(digest!==last){last=digest;onChange();}if(again){again=false;void refresh();}}
 }
 function projection(account,ids){
  if(!identity||account!==identity)return {sourceConnected:false,entries:[],boards:[],error:'当前账号没有已核实的本机状态来源'};
  const wanted=new Set(ids),entries=current.entries.filter(e=>wanted.has(e.webThreadId));
  const sessions=new Set(entries.map(e=>e.sessionId));
  const chats=new Set(entries.map(e=>e.chatId));
  const boards=(current.boards||[]).filter(b=>b.groups.some(g=>wanted.has(g.webChatId)||chats.has(g.chatId)));
  return {...current,entries,boards,webArtifacts:(current.webArtifacts||[]).filter(a=>sessions.has(a.sessionId)),transport:'existing-mac-live'};
 }
 let watcher;try{watcher=fs.watch(web,(_,name)=>{if(['topic-projection.json','live-status.json'].includes(String(name)))void refresh();});}catch{}
 // Health checks have the same cadence as the existing transport heartbeat;
 // they detect a dead helper or a changed browser account even with no writes.
 const timer=setInterval(()=>void refresh(),interval);timer.unref();void refresh();
 return {projection,refresh,close(){stopped=true;clearInterval(timer);watcher?.close();}};
}
module.exports={createLiveSource,browserAccount};
