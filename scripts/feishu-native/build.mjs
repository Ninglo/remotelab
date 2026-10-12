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
content=content.replace('  if (globalThis.__RLFE_LIVE__) return;\n  globalThis.__RLFE_SYNC_CLEANUP__?.();','  globalThis.__RLFE_SYNC_CLEANUP__?.();');
content=content.replace('if (!chrome?.runtime?.getManifest || globalThis.__RLFE_LIVE__) return;','if (!chrome?.runtime?.getManifest) return;');
content=content.replaceAll('Mac 后台自动检查更新；有未保存内容时延后应用','本地增强 1.2 · 更新由本机安装器管理').replaceAll('以后自动连接和更新，无需再到设置里启用。','连接按当前本地飞书账号保存。');
// Native list names have stable classes for the explicitly supported 8.0.3 build.
content=content.replace('if(!main||!originalName||!originalPreview)continue;', 'if(!main||!originalName)continue;').replace('originalPreview.before(preview);', '(originalPreview||originalName).after(preview);');
content=content.replaceAll('._2b17aec6','._9f5c521').replaceAll('._5d806a78','._97ba617');
const font=await fs.readFile(path.join(web,'fonts/SmileySans-Oblique.woff2'));
let loader=await fs.readFile(path.join(here,'loader.js'),'utf8');loader=loader.replace('__FONT_URL__',JSON.stringify('data:font/woff2;base64,'+font.toString('base64'))).replace('__WEB_BUNDLE__',content);
await fs.writeFile(path.join(output,'runtime-template.js'),loader);await fs.copyFile(path.join(here,'bridge.cjs'),path.join(output,'native_asset_bridge.cjs'));
await fs.writeFile(path.join(output,'source-manifest.json'),JSON.stringify({revision:8,webVersion:manifest.version,sourceContentSha256:hash(original),runtimeSha256:hash(loader),adaptations:['native account API','fixed loopback broker','native list selectors','shared Web navigation mounted inside messenger renderer'],nativeOuterNavCovered:false},null,2));
console.log(JSON.stringify({webVersion:manifest.version,sourceContentSha256:hash(original),bytes:loader.length}));
