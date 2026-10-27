// Feishu Web 1.3: promote the accepted native-list trial onto the fixed 1.2.2 base.
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
 ["['width','density'","['localSortMode','navWidth','groupWidth','feedWidth','width','density'"],
 ["const options={theme:","const options={localSortMode:['native','group','status','topic'],theme:"],
 ["width:[480,1040]","navWidth:[0,300],groupWidth:[0,300],feedWidth:[0,720],width:[480,1040]"]
]);
await patch('settings.js',[
 ["sortMode: 'native', pins: []","sortMode: 'native', localSortMode: 'native', navWidth: 0, groupWidth: 0, feedWidth: 0, pins: []"],
 ["next.pins = Array.isArray","next.localSortMode=['native','group','status','topic'].includes(next.localSortMode)?next.localSortMode:'native';next.groupWidth=bounded(next.groupWidth,0,300,0);next.navWidth=bounded(next.navWidth,0,300,0);next.feedWidth=bounded(next.feedWidth,0,720,0);\n    next.pins = Array.isArray"],
 ["<label for=\"search\">查找话题</label>","<p class=\"note\">拖动导航栏或消息列表右边缘调宽，双击恢复。</p><label for=\"search\">查找话题</label>"],
 ["globalThis.__RLFE_CLEANUP__=()=>{alive=false;","globalThis.__RLFE_CLEANUP__=()=>{alive=false;globalThis.__RLFE_RESIZE_CLEANUP__?.();globalThis.__RLFE_SIDEBAR_CLEANUP__?.();globalThis.__RLFE_NATIVE_SORT_UI_CLEANUP__?.();"]
]);
await patch('settings.js', [[`<label for="sortMode">话题排序</label><select id="sortMode"><option value="native">跟随飞书</option><option value="recent">最近有消息</option><option value="created">最新创建</option><option value="waiting">待处理在前</option></select><p class="note">自选排序下，置顶话题在前，普通会话保留原位置。摘要更新不会打乱顺序；有新消息时可点击提示更新。</p>`, `<select id="sortMode" hidden><option value="native">跟随飞书</option></select><p class="note">在消息列表顶部选择排序，分类沿用飞书原有分组。</p>`]]);
await patch('settings.js', [["globalThis.__RLFE_UPDATE_SETTINGS__=patch=>{", "let displayUpdate=Promise.resolve();globalThis.__RLFE_UPDATE_SETTINGS__=patch=>{const revision=loadRevision;displayUpdate=displayUpdate.then(()=>{if(!alive||revision!==loadRevision)return false;return applyDisplayPatch(patch);});return displayUpdate;};const applyDisplayPatch=patch=>{"]]);
await patch('update-background.js' ,[["release.version===current?'当前版本 '+current+'，已是最新':","!newer(release.version,current)?'当前版本 '+current+'':"]]);
await patch('personal-workspace.js', [["document.querySelector('.appNavbar-navbarMenu')", "document.querySelector('#rlfe-web-shortcuts')"], ["document.querySelector('.appNavbar')?.getBoundingClientRect().right", "document.querySelector('[data-rlfe-web-groups]')?.getBoundingClientRect().right"]]);
await patch('resource-nav.js', [["document.querySelector('.appNavbar-navbarMenu')", "document.querySelector('#rlfe-web-shortcuts')"], ["if (!observed) return;", "if (!observed) return; host.dataset.compact='false'; return;"]]);
await patch('topic-labels.js', [
 ["hide(originalName); hide(originalPreview); hide(main.querySelector('._3766bee7'));", "hide(originalName);\n      for(const el of main.querySelectorAll('[data-rlfe-original]'))if(el!==originalName){el.removeAttribute('data-rlfe-original');originals.delete(el);}main.querySelector('.rlfe-feed-preview')?.remove();"],
 ["      let preview = main.querySelector('.rlfe-feed-preview');\n      if (!preview) { preview = node('div', 'rlfe-feed-preview'); originalPreview.before(preview); }\n      const summary = String(entry.summary || '').replace(/\\s+/g, ' ').trim();\n      if (preview.textContent !== summary) preview.textContent = summary;\n      preview.title = summary;", "      // Message previews remain owned and updated by Feishu."]
]);
await patch('runtime-ui.js', [["话题运行状态、标题摘要和群汇总", "话题运行状态、标题和群汇总"]]);
await patch('runtime-ui.js', [["const version = chrome.runtime.getManifest().version,", "const version = chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version,"]]);
for(const file of ['resize.js','sidebar.js','native-sort.js','sort-ui.js'])await cp(join(here,file),join(out,file));
const locator=await readFile(join(base,'../mini-live/native-feed-locator.js'),'utf8');
const pets={};for(const [id,name]of Object.entries({boocha:'boocha.gif','noto-cat':'cat.webp','noto-fox':'fox.webp','noto-panda':'panda.webp','noto-penguin':'penguin.webp'}))pets[id]='data:image/'+(name.endsWith('.gif')?'gif':'webp')+';base64,'+(await readFile(join(base,'assets',name))).toString('base64');
const parts=await Promise.all(['themes.js','preferences.js','message-settings.js','settings.js','companion.js','reading.js','group-board.js','sidebar.js','resource-nav.js','personal-workspace.js','sort-ui.js','topic-labels.js','resize.js','topic-sync.js','runtime-ui.js'].map(n=>readFile(join(out,n),'utf8')));
await writeFile(join(out,'content.js'),parts.join('\n').replaceAll('__LAB_PET_DATA__',JSON.stringify(pets)).replaceAll('__BEAR_DATA_URL__','data:image/gif;base64,'+(await readFile(join(base,'assets/sticker-bear.gif'))).toString('base64')).replaceAll('__RLFE_BOARD_LOCATOR__',locator));
manifest.version='1.3.0';manifest.version_name='1.3';manifest.description='保留飞书原生摘要与操作，微调左侧入口、列宽和排序。';
manifest.content_scripts.unshift({matches:manifest.content_scripts[0].matches,js:['native-sort.js'],world:'MAIN',run_at:'document_start'});
await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({version:manifest.version,output:out,published:false}));
