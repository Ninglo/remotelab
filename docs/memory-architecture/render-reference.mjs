import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { guide } from './guide-data.js';

const q = String.fromCharCode(96);
const inline = text => q + text + q;
const table = rows => rows.map(row => '| ' + row.map(v => String(v).replaceAll('|','／').replaceAll('\n',' ')).join(' | ') + ' |').join('\n');
const target = fileURLToPath(new URL('./README.md',import.meta.url));
let text = '# ' + guide.title + '\n\n<!-- Generated from guide-data.js by render-reference.mjs; edit the content source. -->\n\n';
text += '版本 '+guide.version+'；核对日期 '+guide.verifiedAt+'；运行源码 '+inline(guide.auditedCommit)+'；主线基线 '+inline(guide.mainBaseline)+'。主要读取与写回文件在两者间一致。\n\n';
text += guide.goal+'\n\n'+guide.boundary+' 未逐条复审全部历史业务事实；治理测试运行层尚未实施。\n\n';
text += '交互入口：[index.html](index.html)。真实人数通过网页按钮在登录后读当前实例，不保存真实名单或私人偏好。\n\n';
text += '## 开工读取\n\n';
for(const [title,body] of guide.findings)text+='**'+title+'。** '+body+'\n\n';
for(const scenario of Object.values(guide.scenarios))text+='### '+scenario.label+'\n\n'+scenario.summary+'\n\n';
text += table([['区域','何时提供或读取','用途'],['---','---','---'],...guide.startGraph.nodes.map(n=>[n.title,n.tag,n.text])])+'\n\n';
text += '补充：Harness 自身的指令、工作区 AGENTS.md 和原生记忆有各自加载链路。连接器上下文由配置和来源决定；已出版日报只在配置的 Jev 路径选择有界片段。可选启动知识探测不等于本地记忆检索。RemoteLab Context 记录证明平台投影，工具读取记录才能证明本轮打开了正文。\n\n';
function graphSection(graph){
  let out=graph.intro+'\n\n'+q.repeat(3)+'mermaid\nflowchart LR\n';
  for(const n of graph.nodes)out+='  '+n.id+'["'+n.title+'"]\n';
  for(const [a,b,label] of graph.edges)out+='  '+a+(label?' -. '+label+' .-> ':' --> ')+b+'\n';
  out+=q.repeat(3)+'\n\n';
  for(const n of graph.nodes)out+='- **'+n.title+'（'+n.tag+'）：** '+n.text+(n.paths?' 入口：'+n.paths.map(inline).join('、')+'。':'')+'\n';
  return out+'\n';
}
text+='## 收尾归集\n\n### 当前机制\n\n'+graphSection(guide.collectGraphs.current)+'### 治理目标（未实施）\n\n'+graphSection(guide.collectGraphs.target);
text+='## 各层区域与维护边界\n\n'+table([['层','范围与状态','入口','何时读／怎样写'],['---','---','---','---'],...guide.layers.map(l=>[l.title,l.scope+'；'+l.status,l.paths.map(inline).join('、'),l.read+'；'+l.write])])+'\n\n';
for(const l of guide.layers)text+='- **'+l.title+'：** '+l.rule+'\n';
text+='\n## 优先修正的缺口\n\n';for(const [title,body] of guide.gaps)text+='- **'+title+'：** '+body+'\n';
text+='\n## 组织、项目与个人\n\n项目和个人是多对多关系。组织共识、项目视图和个人视图从同一批带来源记录生成；任务、作业、结果与验收继续由相应系统维护。偏好需要本人来源与适用范围；未知就写未知。登记人数不等于去重后的组织人数或活跃用户数。\n\n';
text+='PMO 指跨项目协调与推进的职责。Agent 持续核对进展、发现遗漏和依赖、比较重复工作、提取好方法并提出建议。人确认目标与取舍、自己的承诺和现实验收。没有日志不等于没有工作；进度百分比必须有明确里程碑、分母和验收依据。\n\n';
text+=table([['信息字段','保存什么'],['---','---'],...guide.recordFields])+'\n\n';
text+=table([['确认职责','确认内容'],['---','---'],...guide.roles])+'\n\n确认绑定条目版本。实质修改后，相关确认重新核对；无回应不等于认可。明确的普通事实可以自动查证，不要求所有人逐条点击。工作流发现允许一例有用实践，活动 Skill 晋升另需真实独立复用证据。\n\n';
text+='## 落地顺序与验收\n\n';for(const p of guide.phases)text+='### '+p.label+'\n\n'+p.enabled+'\n\n'+p.disabled+'\n\n验收：'+p.accept+'\n\n';
text+='### 测试隔离\n\n'+guide.isolation+'\n\n';
text+=table([['最终效果','评估内容'],['---','---'],...guide.metrics])+'\n\n';
text+='## 当前依据\n\n';for(const r of guide.references)text+='- ['+r.title+'](../../'+r.path+')：'+r.use+'。\n';
text+='\n## 外部参考\n\n';for(const r of guide.external)text+='- ['+r.title+']('+r.url+')：'+r.use+'\n';
text+='\n## 维护\n\n';for(const t of guide.maintenance)text+='- '+t+'\n';
text+='\n编辑 '+inline('guide-data.js')+' 后运行 '+inline('node docs/memory-architecture/render-reference.mjs')+'；用 '+inline('--check')+' 检查参考文本是否同步。发布仅包括 '+inline('index.html')+'、'+inline('style.css')+'、'+inline('app.js')+'、'+inline('guide-data.js')+' 和 '+inline('README.md')+'。\n';
if(process.argv.includes('--check')){
  if(await readFile(target,'utf8')!==text)throw new Error('Reference text differs from guide-data.js; regenerate it.');
  console.log('Reference text matches shared content source.');
}else{await writeFile(target,text);console.log('Generated '+target);}
