import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url)),[web,output]=process.argv.slice(2);if(!web||!output)throw Error('Usage: node build.mjs WEB_SOURCE OUTPUT');
await fs.mkdir(output,{recursive:true});const read=n=>fs.readFile(path.join(web,n),'utf8');
const manifest=JSON.parse(await read('manifest.json'));if(manifest.version!=='1.2.0')throw Error('Expected reviewed Web 1.2.0');
const original=await read('content.js'),hash=s=>createHash('sha256').update(s).digest('hex');
let content=original;const start=content.indexOf('(() => {\n  globalThis.__RLFE_PREFS_CLEANUP__?.();');const end=content.indexOf("(() => {\n  const base = 'https://zhangyu.jiujianian.dev', key = 'feishuWebExplore.messageConnection.v1';",start);if(start<0||end<0)throw Error('Unrecognized Web bundle');
const pref=await read('preferences.js'),validation=pref.slice(pref.indexOf('  function portable('),pref.indexOf('  function notify('));
let adapter=(await fs.readFile(path.join(here,'adapter.js'),'utf8')).replace('__PORTABLE_VALIDATION__',validation);
content=content.slice(0,start)+adapter+'\n'+content.slice(end);
function replaceOnce(before,after){if(content.split(before).length!==2)throw Error('Web adapter source changed: '+before.slice(0,65));content=content.replace(before,after);}
replaceOnce("topics = () => [...document.querySelectorAll('.threadWrapper[data-thread-id]')]",'topics = () => globalThis.__RLFE_NATIVE_WEB_TOPIC_ROWS__()');
replaceOnce('const nativeName = el => (','const nativeName = el => (globalThis.__RLFE_NATIVE_WEB_TOPIC_NAME__?.(el) || ');
// Share original components; adapt only browser transport, account origin and native selectors.
content=content.replaceAll('location.origin','globalThis.__RLFE_NATIVE_ORIGIN__').replaceAll("https://zhangyu.jiujianian.dev",'https://index.jiujianian.dev');
content=content.replaceAll('const storage = live ?', 'const storage = false ?');
content=content.replaceAll('if (!live) result = await chrome.runtime.sendMessage','if (true) result = await chrome.runtime.sendMessage');
content=content.replaceAll('event.source !== popup', 'event.data?.nativePopup !== popup?.nativePopup');
// The broker selects either the existing same-account source or a standalone
// personal topic grant. Do not start a competing renderer-owned stream.
content=content.replace('if (!chrome?.runtime?.getManifest || globalThis.__RLFE_LIVE__) return;','if (!chrome?.runtime?.getManifest) return;');
content=content.replaceAll('Mac 后台自动检查更新；有未保存内容时延后应用','本地增强 1.2 · 更新由本机安装器管理').replaceAll('以后自动连接和更新，无需再到设置里启用。','连接按当前本地飞书账号保存。');
// Replace the browser feed renderer at a checked boundary. Native title/digest
// slots differ from Web and must not share its hash-selector substitutions.
const topicStart=content.indexOf('(() => {\n  globalThis.__RLFE_TOPICS_CLEANUP__?.();');
const topicEnd=content.indexOf('\n})();',topicStart)+7;
if(topicStart<0||topicEnd<topicStart)throw Error('Unrecognized Web topic renderer');
content=content.slice(0,topicStart)+await fs.readFile(path.join(here,'topic-view.js'),'utf8')+content.slice(topicEnd);
// Personal panels fill their native renderer below the enhancement toolbar.
for(const height of [68,76])content=content.replaceAll('height:calc(100dvh - '+height+'px)', 'height:calc(100% - '+height+'px)');
// The Web Live controller loads these two additional components outside content.js.
const live=process.argv[4];if(!live)throw Error('Expected reviewed Mac Web Live extension directory');
const extras={};for(const name of ['usage-view.js','web-artifact.js'])extras[name]=await fs.readFile(path.join(live,name),'utf8');
let usage=extras['usage-view.js'].replace('const selected=globalThis.__feedStore?.getState?.().status?.activeFeedId;','const selected=globalThis.__RLFE_NATIVE_CONTEXT__?.().threadId || globalThis.__feedStore?.getState?.().status?.activeFeedId;');
usage=usage.replace('const oldSync = !Number.isFinite(syncAt)', 'const oldSync = data.sourceConnected===false || entry.sourceStale || !Number.isFinite(syncAt)');
content=content.replaceAll("globalThis.__RLFE_USAGE_STATUS__?.().activeSession", "(globalThis.__RLFE_NATIVE_ACTIVE_SESSION__?.() || globalThis.__RLFE_USAGE_STATUS__?.().activeSession)");
content+='\n'+usage+'\n'+extras['web-artifact.js'];
// Native chat and list are separate renderers; the committed native header
// supplies chat identity, while only the list renderer performs navigation.
content=content.replace('function nativeContext(header){',`function nativeContext(header){
  const native=globalThis.__RLFE_NATIVE_CONTEXT__?.();
  if(native){const entry=(projection.entries||[]).find(e=>e.webThreadId===native.threadId);
   if(entry)return {chatId:entry.chatId,selected:native.threadId};
   const group=(projection.boards||[]).flatMap(b=>b.groups||[]).find(g=>g.webChatId===native.webChatId);
   return group?{chatId:group.chatId,selected:native.threadId||native.webChatId}:null;}
`);
content=content.replace('function nativeContext(header){','globalThis.__RLFE_NATIVE_LIST_LOCATE__=navigate;\n function nativeContext(header){');
content=content.replace("get('counts').textContent=current?","get('counts').textContent=projection.sourceConnected===false?'未同步':current?").replace("t.sourceStale?'状态待核（暂未同步）'","(projection.sourceConnected===false||t.sourceStale)?'状态待核（暂未同步）'");
content=content.replace("const text=['running','waiting','review'].includes(r.status)?r.status:'';","const text=r.sourceStale||projection.sourceConnected===false?'未同步':['running','waiting','review'].includes(r.status)?r.status:'';");
content=content.replace('await navigate(t.webThreadId);','await globalThis.__RLFE_NATIVE_NAVIGATE__(t.webThreadId);');
const font=await fs.readFile(path.join(web,'fonts/SmileySans-Oblique.woff2'));
let loader=await fs.readFile(path.join(here,'loader.js'),'utf8');loader=loader.replace('__FONT_URL__',JSON.stringify('data:font/woff2;base64,'+font.toString('base64'))).replace('__WEB_BUNDLE__',content);
await fs.writeFile(path.join(output,'runtime-template.js'),loader);await fs.copyFile(path.join(here,'bridge.cjs'),path.join(output,'native_asset_bridge.cjs'));
await fs.copyFile(path.join(here,'live-source.cjs'),path.join(output,'live-source.cjs'));
await fs.copyFile(path.join(here,'topic-source.cjs'),path.join(output,'topic-source.cjs'));
await fs.writeFile(path.join(output,'source-manifest.json'),JSON.stringify({revision:12,liveComponentHashes:Object.fromEntries(Object.entries(extras).map(([name,value])=>[name,hash(value)])),webVersion:manifest.version,sourceContentSha256:hash(original),runtimeSha256:hash(loader),buildHash:hash(loader+await fs.readFile(path.join(here,'bridge.cjs'),'utf8')+await fs.readFile(path.join(here,'topic-source.cjs'),'utf8')+await fs.readFile(path.join(here,'live-source.cjs'),'utf8')),adaptations:['native account API','fixed loopback broker','native list selectors','shared Web navigation mounted inside messenger renderer'],nativeOuterNavCovered:false},null,2));
console.log(JSON.stringify({webVersion:manifest.version,sourceContentSha256:hash(original),bytes:loader.length}));
