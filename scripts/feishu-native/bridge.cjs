// Local helper for the isolated, user-owned Feishu Native Trial application.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomBytes}=require('node:crypto'),{execFile}=require('node:child_process');
const root=process.env.RLFE_TRIAL_ROOT||path.join(os.homedir(),'Library/Application Support/RemoteLab/Feishu Native Trial');
const origin='http://127.0.0.1:19342', remote='https://index.jiujianian.dev';
const {createLiveSource}=require('./live-source.cjs');
const {createTopicSource}=require('./topic-source.cjs');
const token=fs.readFileSync(path.join(root,'native-asset-capability'),'utf8').trim();
const states=new Map(),streams=new Map(),pairings=new Map(),subscriptions=new Map(),navigations=new Map();
const disk=path.join(root,'native-v8-storage.json');
const store=fs.existsSync(disk)?JSON.parse(fs.readFileSync(disk,'utf8')):{version:1,accounts:{}};
const accountOK=x=>typeof x==='string'&&/^\d{10,30}$/.test(x);
const clientOK=x=>typeof x==='string'&&/^[a-f0-9-]{20,50}$/.test(x);
const fail=message=>{throw Error(message)};
function persist(){fs.writeFileSync(disk+'.next',JSON.stringify(store),{mode:0o600});fs.renameSync(disk+'.next',disk);}
function own(account){if(!accountOK(account))fail('请先登录本地飞书账号');if(!store.accounts[account]){store.accounts[account]={storage:{},prefs:{}};if(!store.migratedTo){store.accounts[account].prefs=JSON.parse(fs.readFileSync(path.join(root,'web-display-choice.json'),'utf8'));store.migratedTo=account;}persist();}return store.accounts[account];}
function emit(account,type,value,except){for(const [id,s]of streams)if(s.account===account&&id!==except)s.res.write(JSON.stringify({type,value})+'\n');}
const source=createLiveSource({root,web:path.join(os.homedir(),'Library/Application Support/RemoteLab/Feishu Web Live'),onChange:publishTopics});
const personalSource=createTopicSource({remote,origin,onChange:publishTopics});
const topicKey=account=>'feishuWebExplore.topicConnection.v1:'+encodeURIComponent(origin+':'+account);
function legacyAccount(){try{return JSON.parse(fs.readFileSync(path.join(root,'native-source-account.json'),'utf8')).account;}catch{return '';}}
function nativeProjection(account){
 const pages=[...states.values()].filter(s=>s.account===account),ids=pages.flatMap(s=>s.ids||[]);
 const legacy=legacyAccount()===account;
 if(!legacy)personalSource.update(account,own(account).storage[topicKey(account)],ids,pages.map(s=>s.nativeContext?.webChatId).filter(Boolean));
 return {...(legacy?source.projection(account,ids):personalSource.projection(account)),transport:legacy?'existing-mac-live':'personal-grant',nativeContext:pages.find(s=>s.kind==='chat')?.nativeContext||null};
}
function publishTopics(){for(const account of new Set([...streams.values()].map(s=>s.account)))emit(account,'topics',nativeProjection(account));}
function record(){fs.writeFileSync(path.join(root,'native-asset-status.json'),JSON.stringify({pid:process.pid,revision:10,webVersion:'1.2.0',pages:[...states.values()],nativeOuterNavCovered:false},null,2),{mode:0o600});}
function safePrefs(v,account){const fields=['enabled','usageEnabled','theme','font','bodyFont','readingEnabled','size','line','width','density','layout','expand','aliases','petEnabled','petKind','petMotion','petSize','petX','petY','sortMode','pins'];if(!v||Array.isArray(v)||Object.keys(v).some(k=>!fields.includes(k))||JSON.stringify(v).length>131072)fail('显示设置无效');const old=own(account).prefs;const ids=new Set([...states.values()].filter(s=>s.account===account).flatMap(s=>s.ids||[]));if(Object.entries(v.aliases||{}).some(([k,n])=>!/^:\d{10,30}$/.test(k)||typeof n!=='string'||n.length>60||!ids.has(k.slice(1))&&!Object.hasOwn(old.aliases||{},k)))fail('只允许修改当前账号的话题别名');return v;}
const routes={
 'rlfe:message-settings-request':{prefix:'feishu-web-settings',pattern:/^fwset_[\w-]{43}$/,ops:{read:['GET','replies'],save:['POST','replies'],runtime:['GET','runtime'],model:['POST','runtime'],disconnect:['DELETE','connection']}},
 'rlfe:personal-workspace-request':{prefix:'feishu-web-workspace',pattern:/^fwspace_[\w-]{43}$/,ops:{context:['GET','context'],index:['GET','index'],thinking:['GET','thinking'],sendIndex:['POST','index'],analyze:['POST','thinking'],disconnect:['DELETE','connection']}}
};
async function broker(m,account){const spec=routes[m.type],route=spec?.ops[m.operation];if(!route||!spec.pattern.test(m.token||'')||m.account!==account)fail('账号或请求无效');let query='';if(m.operation==='runtime')query='?sessionId='+encodeURIComponent(m.sessionId||'');else if(m.requestId){if(!/^[\w-]{16,80}$/.test(m.requestId))fail('请求编号无效');query='?requestId='+encodeURIComponent(m.requestId);}const body=m.body===undefined?undefined:JSON.stringify(m.body);if(body?.length>32768)fail('内容过长');const r=await fetch(`${remote}/api/${spec.prefix}/${route[1]}${query}`,{method:route[0],credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+m.token,'Content-Type':'application/json','X-Feishu-Origin':origin,'X-Feishu-Account':account},body});return {ok:r.ok,status:r.status,data:await r.json()};}
async function topicStream(m,account,id){
 if(!/^fwtops_[\w-]{43}$/.test(m.token||'')||m.account!==account||!Array.isArray(m.ids)||m.ids.length>200||m.ids.some(v=>!/^[\w-]{1,80}$/.test(v)))fail('话题连接无效');
 subscriptions.get(id)?.abort();const controller=new AbortController();controller.portId=m.portId;subscriptions.set(id,controller);
 const send=value=>{const s=streams.get(id);if(s?.account===account)s.res.write(JSON.stringify({type:'topic-stream',value:{portId:m.portId,...value}})+'\n');};
 try{const r=await fetch(remote+'/api/feishu-web-topics/stream?ids='+encodeURIComponent(m.ids.join(',')),{redirect:'error',signal:controller.signal,headers:{Authorization:'Bearer '+m.token,'X-Feishu-Origin':origin,'X-Feishu-Account':account}});if(!r.ok)throw Error((await r.json()).error||'话题同步不可用');let buffer='';for await(const value of r.body){buffer+=Buffer.from(value).toString();if(buffer.length>2097152)throw Error('同步数据过大');let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);send({type:'heartbeat'});const line=block.split('\n').find(s=>s.startsWith('data: '));if(line)send({type:'projection',data:JSON.parse(line.slice(6))});}}if(!controller.signal.aborted)send({type:'error',error:'同步连接已断开'});}catch(e){if(!controller.signal.aborted)send({type:'error',error:e.message});}finally{if(subscriptions.get(id)===controller)subscriptions.delete(id);}
}
function openURL(url){return new Promise((resolve,reject)=>execFile('/usr/bin/open',[url],e=>e?reject(e):resolve()));}
function publicPairPage(p,key){const dest=remote+'/page/feishu-web-'+p.kind+'/connect?origin='+encodeURIComponent(origin)+'&account='+p.account+'&state='+p.state;return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>连接飞书本地增强</title><style>body{font:16px/1.7 system-ui;max-width:440px;margin:40px auto}button{font:inherit;padding:10px 18px}</style><h2>连接本人账号</h2><p>在下一页登录并核对姓名，连接完成后返回飞书。</p><button id="go">打开账号连接页</button><p id="status"></p><script>let popup;const remote=${JSON.stringify(remote)},state=${JSON.stringify(p.state)};document.getElementById('go').onclick=()=>{popup=window.open(${JSON.stringify(dest)},'rlfe-native-connect','popup,width=520,height=600')};window.addEventListener('message',async e=>{if(e.origin!==remote||e.source!==popup||e.data?.state!==state)return;const r=await fetch('/pair/finish?key='+${JSON.stringify(key)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e.data)});document.getElementById('status').textContent=r.ok?'已连接，可以返回飞书。':'连接失败，请从飞书重新打开。';if(r.ok)document.getElementById('go').disabled=true;});</script>`;}
const server=http.createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
 if(req.headers.host!=='127.0.0.1:19342'){res.writeHead(403);res.end();return;}
 const u=new URL(req.url,origin);
 const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 try{
  if(u.pathname.startsWith('/pair/')){
   const key=u.searchParams.get('key'),p=pairings.get(key);if(!p||p.until<Date.now())fail('连接页面已过期，请从飞书重新打开');
   if(u.pathname==='/pair/start'&&req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");res.end(publicPairPage(p,key));return;}
   if(u.pathname==='/pair/finish'&&req.method==='POST'&&req.headers.origin===origin){const data=JSON.parse(await readBody(req,12000));const tag=p.kind==='workspace'?'workspace':p.kind==='topics'?'topics':'settings';const pattern=tag==='workspace'?/^fwspace_[\w-]{43}$/:tag==='topics'?/^fwtops_[\w-]{43}$/:/^fwset_[\w-]{43}$/;if(data.state!==p.state||data.origin!==origin||data.nativeAccount!==p.account||data.type!==`remotelab:feishu-${tag}-connected`||!pattern.test(data.token||'')||!(data.expiresAt>Date.now()))fail('账号连接信息不匹配');const prefix=tag==='workspace'?'workspaceConnection':tag==='topics'?'topicConnection':'messageConnection';const storageKey='feishuWebExplore.'+prefix+'.v1:'+encodeURIComponent(origin+':'+p.account);own(p.account).storage[storageKey]=data;persist();emit(p.account,'storage',{[storageKey]:{newValue:data}});emit(p.account,'connected',{...data,nativePopup:p.popup});pairings.delete(key);publishTopics();reply(200,{ok:true});return;}fail('连接请求无效');
  }
  const cors=req.headers.origin;if(cors&&cors!=='null'&&cors!==origin){reply(403,{error:'Invalid origin'});return;}res.setHeader('Access-Control-Allow-Origin',cors||'null');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Native-Account, X-Native-Client');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(req.headers.authorization!=='Bearer '+token){reply(403,{error:'Invalid helper capability'});return;}
  const account=req.headers['x-native-account'],id=req.headers['x-native-client'];
  if(u.pathname==='/status'&&req.method==='GET'){reply(200,{pid:process.pid,revision:10,pages:[...states.values()]});return;}
  if(u.pathname==='/verify'&&req.method==='POST'){for(const s of streams.values())s.res.write(JSON.stringify({type:'verify'})+'\n');reply(200,{requested:true});return;}
  if(!clientOK(id)||!accountOK(account))fail('请先确认当前本地飞书账号');
  if(u.pathname==='/events'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.flushHeaders();streams.get(id)?.res.end();streams.set(id,{res,account});res.write(JSON.stringify({type:'settings',value:own(account).prefs})+'\n');res.write(JSON.stringify({type:'topics',value:nativeProjection(account)})+'\n');res.on('close',()=>{if(streams.get(id)?.res===res){streams.delete(id);states.delete(id);subscriptions.get(id)?.abort();if(![...streams.values()].some(s=>s.account===account))personalSource.remove(account);record();}});return;}
  const b=req.method==='POST'?JSON.parse(await readBody(req,180000)):{};let result;
  if(u.pathname==='/initial')result={settings:own(account).prefs,topics:nativeProjection(account)};
  else if(u.pathname==='/state'){if(!['list','chat'].includes(b.kind)||!Array.isArray(b.ids)||b.ids.length>250)fail('Invalid state');states.set(id,{...b,id,account});record();publishTopics();result={ok:true};}
  else if(u.pathname==='/save'){own(account).prefs=safePrefs(b.value,account);persist();emit(account,'settings',b.value,id);result={ok:true};}
  else if(u.pathname==='/preview'){const v={...b.value};delete v.previewing;safePrefs(v,account);emit(account,'settings',v,id);result={ok:true};}
  else if(u.pathname==='/storage/get'){if(typeof b.key!=='string'||!b.key.startsWith('feishuWebExplore.'))fail('Invalid key');result={[b.key]:own(account).storage[b.key]??null};}
  else if(u.pathname==='/storage/set'){const changes={};for(const[k,v]of Object.entries(b.values||{})){if(!k.startsWith('feishuWebExplore.')||k.length>400)fail('Invalid key');changes[k]={oldValue:own(account).storage[k],newValue:v};own(account).storage[k]=v;}persist();emit(account,'storage',changes);result={ok:true};}
  else if(u.pathname==='/request')result=await broker(b,account);
  else if(u.pathname==='/topics/start'){void topicStream(b,account,id);result={ok:true};}
  else if(u.pathname==='/topics/stop'){const old=subscriptions.get(id);if(old?.portId===b.portId)old.abort();result={ok:true};}
  else if(u.pathname==='/connect'){if(!['settings','workspace','topics'].includes(b.kind)||!/^[a-f0-9]{32}$/.test(b.state||'')||typeof b.popup!=='string')fail('连接请求无效');const key=randomBytes(24).toString('base64url');for(const[k,p]of pairings)if(p.until<Date.now())pairings.delete(k);pairings.set(key,{kind:b.kind,state:b.state,popup:b.popup,account,until:Date.now()+600000});await openURL(origin+'/pair/start?key='+key);result={opened:true};}
  else if(u.pathname==='/external'){const url=new URL(b.url);if(url.protocol!=='https:'||url.username||url.password||!['index.jiujianian.dev','zhangyu.jiujianian.dev','qcnatfwzm13g.feishu.cn'].includes(url.hostname))fail('链接不受支持');await openURL(url.href);result={opened:true};}
  else if(u.pathname==='/refresh-source'){await source.refresh();publishTopics();result={ok:true};}
  else if(u.pathname==='/navigate'){
   if(!/^\d{10,30}$/.test(b.id||'')||!nativeProjection(account).boards.some(board=>board.topics.some(t=>t.webThreadId===b.id)))fail('话题未核实');
   const page=[...states.values()].find(s=>s.account===account&&s.kind==='list'),stream=page&&streams.get(page.id);if(!stream)fail('原生列表未连接');
   const requestId=randomBytes(16).toString('hex');result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{navigations.delete(requestId);reject(Error('原生话题打开超时'));},14000);navigations.set(requestId,{account,client:page.id,finish:error=>{clearTimeout(timer);navigations.delete(requestId);error?reject(Error(error)):resolve({ok:true});}});stream.res.write(JSON.stringify({type:'navigate',value:{id:b.id,requestId}})+'\n');});
  }
  else if(u.pathname==='/navigation-result'){const p=navigations.get(b.requestId);if(!p||p.account!==account||p.client!==id)fail('导航回执无效');p.finish(b.error?String(b.error).slice(0,200):null);result={ok:true};}
  else if(u.pathname==='/open-settings'){emit(account,'open-settings',true,id);result={ok:true};}
  else if(u.pathname==='/verification'){fs.writeFileSync(path.join(root,'native-v8-verification.json'),JSON.stringify(b,null,2),{mode:0o600});result={ok:true};}
  else{reply(404,{error:'Unknown native operation'});return;}reply(200,result);
 }catch(e){reply(400,{error:e.message});}
});
async function readBody(req,limit){const chunks=[];let n=0;for await(const b of req){n+=b.length;if(n>limit)fail('请求过大');chunks.push(b);}return Buffer.concat(chunks).toString();}
server.listen(19342,'127.0.0.1',()=>{record();console.log('Native 1.2 helper ready');});
const heartbeat=setInterval(()=>{for(const s of streams.values())s.res.write(JSON.stringify({type:'heartbeat'})+'\n');},15000);heartbeat.unref();
process.on('SIGTERM',()=>{clearInterval(heartbeat);source.close();personalSource.close();for(const c of subscriptions.values())c.abort();for(const s of streams.values())s.res.end();server.close();process.exit(0);});
