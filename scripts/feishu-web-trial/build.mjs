// Local, reversible width trial; retain the ordinary Feishu message list.
import { cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const [baseArg,outArg]=process.argv.slice(2);
if(!baseArg||!outArg)throw Error('Pass ordinary extension source and separate output directory');
const base=resolve(baseArg),out=resolve(outArg);if(base===out)throw Error('Trial output must be separate');
const manifest=JSON.parse(await readFile(join(base,'manifest.json'),'utf8'));
if(manifest.version!=='1.2.2')throw Error('Review patches against the new base first');
await mkdir(out,{recursive:true});await cp(base,out,{recursive:true});
async function patch(file,edits){let text=await readFile(join(out,file),'utf8');for(const [from,to] of edits){if(!text.includes(from))throw Error(file+': missing patch '+from.slice(0,60));text=text.replaceAll(from,to);}await writeFile(join(out,file),text);}
await patch('preferences.js',[
 ["['width','density'","['navWidth','feedWidth','width','density'"],
 ["width:[480,1040]","navWidth:[0,300],feedWidth:[0,720],width:[480,1040]"]
]);
await patch('settings.js',[
 ["sortMode: 'native', pins: []","sortMode: 'native', navWidth: 0, feedWidth: 0, pins: []"],
 ["next.pins = Array.isArray","next.navWidth=bounded(next.navWidth,0,300,0);next.feedWidth=bounded(next.feedWidth,0,720,0);\n    next.pins = Array.isArray"],
 ["<label for=\"search\">查找话题</label>","<p class=\"note\">拖动导航栏或消息列表右边缘调宽，双击恢复。</p><label for=\"search\">查找话题</label>"],
 ["globalThis.__RLFE_CLEANUP__=()=>{alive=false;","globalThis.__RLFE_CLEANUP__=()=>{alive=false;globalThis.__RLFE_RESIZE_CLEANUP__?.();"]
]);
await patch('update-background.js',[["release.version===current?'当前版本 '+current+'，已是最新':","!newer(release.version,current)?'当前版本 '+current+'':"]]);
await cp(join(here,'resize.js'),join(out,'resize.js'));
const locator=await readFile(join(base,'../mini-live/native-feed-locator.js'),'utf8');
const pets={};for(const [id,name]of Object.entries({boocha:'boocha.gif','noto-cat':'cat.webp','noto-fox':'fox.webp','noto-panda':'panda.webp','noto-penguin':'penguin.webp'}))pets[id]='data:image/'+(name.endsWith('.gif')?'gif':'webp')+';base64,'+(await readFile(join(base,'assets',name))).toString('base64');
const parts=await Promise.all(['themes.js','preferences.js','message-settings.js','settings.js','companion.js','reading.js','group-board.js','resource-nav.js','personal-workspace.js','sorter.js','topic-labels.js','resize.js','topic-sync.js','runtime-ui.js'].map(n=>readFile(join(out,n),'utf8')));
await writeFile(join(out,'content.js'),parts.join('\n').replaceAll('__LAB_PET_DATA__',JSON.stringify(pets)).replaceAll('__BEAR_DATA_URL__','data:image/gif;base64,'+(await readFile(join(base,'assets/sticker-bear.gif'))).toString('base64')).replaceAll('__RLFE_BOARD_LOCATOR__',locator));
manifest.version='1.2.5';manifest.version_name='1.2.5 列宽试用';manifest.description='保留飞书原有消息列表，仅增加边缘拖动调宽。';
await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({version:manifest.version,output:out,published:false}));
