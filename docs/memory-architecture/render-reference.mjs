import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { guide, calculateTokenScenario } from './guide-data.js';
import { memoryPurposes, memorySupport, memoryFileMap, filingIncident, filingRisks } from './reader-data.js';

const q = String.fromCharCode(96);
const inline = text => q + text + q;
const table = rows => rows.map(row => '| ' + row.map(v => String(v).replaceAll('|','／').replaceAll('\n',' ')).join(' | ') + ' |').join('\n');
const target = fileURLToPath(new URL('./README.md',import.meta.url));
let text = '# ' + guide.title + '\n\n<!-- Generated from guide-data.js by render-reference.mjs; edit the content source. -->\n\n';
text += '版本 '+guide.version+'；核对日期 '+guide.verifiedAt+'；运行源码 '+inline(guide.auditedCommit)+'；主线基线 '+inline(guide.mainBaseline)+'。旧版已冻结；项目钩子新增指针投影，其余正文读取仍由 Harness 选择。实际部署版本以实例 build-info 为准。\n\n';
text += guide.goal+'\n\n'+guide.boundary+' 未逐条复审全部历史业务事实；运行接入和实际效果、人按职责认可分别验收。\n\n';
text += '本章属于 [RemoteLab 整体说明项目](../architecture-atlas/README.md)，统一目录和发布规则在该项目维护。交互入口：[index.html](index.html)。真实人数通过网页按钮在登录后读当前实例，不保存真实名单或私人偏好。\n\n';
text += '## 方案骨架\n\n';
for(const [title,body] of guide.findings)text+='**'+title+'。** '+body+'\n\n';
text += graphSection(guide.architectureGraph);
for(const [title,body] of guide.principles)text+='- **'+title+'：** '+body+'\n';
text += '\n## 存储地图：现状与方案\n\n配置目录默认 '+inline('~/.config/remotelab')+'，记忆目录默认 '+inline('~/.remotelab/memory')+'；实例环境变量可覆盖。连接器 '+inline('storageDir')+' 由其配置决定，'+inline('project-knowledge/')+' 为独立项目知识目录。Session ID 为稳定身份。Harness 原生会话／记忆在运行配置选定的 provider home，平台保存恢复标识；平台事件不等于全部原生上下文。\n\n';
for(const item of guide.storageCases){
  text+='### '+item.label+'：'+item.question+'\n\n';
  for(const [mode,label] of [['current','目前实际存储'],['target','治理方案（分项实施）']]){
    const s=item[mode];
    text+='**'+label+'**\n\n入口：'+s.paths.map(inline).join('、')+'。\n\n'+s.body+'\n\n读取：'+s.read+'\n\n写入：'+s.write+'\n\n';
  }
}
text+='## 项目归属规则（已接入导航，未知关联待核）\n\n';
text+='## 三个并列的业务档案\n\n项目记事情，人员记怎样合作，公司记共同背景；来源、入口、规则、状态与格式不再和业务归属混成层级。\n\n';
for(const item of memoryPurposes)text+='### '+item.label+'\n\n'+item.content+'\n\n正文：'+item.path+'。读取：'+item.read+'\n\n'+item.example+'\n\n';
for(const [role,names,purpose]of memorySupport)text+='- **'+role+'**：'+names+'。'+purpose+'\n';
text+='\n日报与时间线是派生视图；现有历史文件尚未全部迁移或逐条认可。\n\n';
text+='## 文件命名、实际位置和分档纠错\n\n[原阅读页的完整文件地图](../architecture-atlas/output/index.html#memory-files)与本表来自同一内容源；登录该页14可读本实例文件名、绝对路径和当前有效写回目标。\n\n';
text+=table([['区域','文件名','位置','内容','维护边界'],['---','---','---','---','---'],...memoryFileMap])+'\n\n';
text+=filingIncident.cause+'\n\n'+filingIncident.correction+'\n\n'+filingIncident.recurrence+'\n\n';
for(const [risk,cause,fix]of filingRisks)text+='- **'+risk+'**：'+cause+' '+fix+'\n';
for(const [title,body] of guide.scopeRules)text+='- **'+title+'：** '+body+'\n';
text+='\n范围登记是一份后台关联关系，生成导航和连接器绑定，不新增交互式项目产品；认识仍在主账。\n\n'+table([['登记字段','保存内容'],['---','---'],...guide.registryFields])+'\n\n';
for(const c of guide.routeExamples)text+='\n### '+c.label+'（虚构）\n\n'+c.input+'\n\n归属：'+c.route+'\n\n依据：'+c.basis+'\n\n写入：'+c.store+'\n\n开工读取：'+c.read+'\n';
text += '\n## 按任务读取的方案\n\n';
for(const c of guide.readingCases){
  text+='### '+c.label+'\n\n';
  c.steps.forEach(([title,body],i)=>{text+=(i+1)+'. **'+title+'：** '+body+'\n';});
  text+='\n通常无需读：'+c.skip+'\n\n';
}
text+='### 指针治理\n\n';for(const [title,body] of guide.pointerRules)text+='- **'+title+'：** '+body+'\n';
text += '\n## 当前已运行的开工加载机制\n\n';
for(const scenario of Object.values(guide.scenarios))text+='### '+scenario.label+'\n\n'+scenario.summary+'\n\n';
text += table([['区域','何时提供或读取','用途'],['---','---','---'],...guide.startGraph.nodes.map(n=>[n.title,n.tag,n.text])])+'\n\n';
text += '补充：Harness 自身的指令、工作区 AGENTS.md 和原生记忆有各自加载链路。连接器上下文由配置和来源决定；已出版日报只在配置的 Jev 路径选择有界片段。可选启动知识探测不等于本地记忆检索。RemoteLab Context 记录证明平台投影，工具读取记录才能证明本轮打开了正文。\n\n';
function graphSection(graph){
  let out=(graph.intro ? graph.intro+'\n\n' : '')+q.repeat(3)+'mermaid\nflowchart LR\n';
  for(const n of graph.nodes)out+='  '+n.id+'["'+n.title+'"]\n';
  for(const [a,b,label] of graph.edges)out+='  '+a+(label?' -. '+label+' .-> ':' --> ')+b+'\n';
  out+=q.repeat(3)+'\n\n';
  for(const n of graph.nodes)out+='- **'+n.title+'（'+n.tag+'）：** '+n.text+(n.paths?' 入口：'+n.paths.map(inline).join('、')+'。':'')+'\n';
  return out+'\n';
}
text+='## 写入分类：哪些内容放哪里\n\n';
for(const c of guide.classificationCases)text+='### '+c.label+'\n\n示例（虚构）：'+c.example+'\n\n性质：'+c.type+'。维护位置：'+c.target+'。\n\n入口：'+c.paths.map(inline).join('、')+'。\n\n'+c.rule+'\n\n'+c.other+'\n\n';
text+='### 写入与生效规则\n\n';for(const [title,body] of guide.writeRules)text+='- **'+title+'：** '+body+'\n';
text+='\n## 共识与反馈\n\n### 治理目标（未实施）\n\n'+graphSection(guide.collectGraphs.target)+'### 当前机制\n\n'+graphSection(guide.collectGraphs.current);
text+='### 一次反馈如何修正原条目（虚构）\n\n';guide.feedbackStory.forEach(([title,body],i)=>{text+=(i+1)+'. **'+title+'：** '+body+'\n';});
text+='\n## 维护位置之间的关系\n\n这些位置按用途分工，不是逐级复制的共识文档；日报不是新的一层记忆。\n\n'+table([['用途','范围与状态','入口','何时读／怎样写'],['---','---','---','---'],...guide.layers.map(l=>[l.title,l.scope+'；'+l.status,l.paths.map(inline).join('、'),l.read+'；'+l.write])])+'\n\n';
for(const l of guide.layers)text+='- **'+l.title+'：** '+l.rule+'\n';
text+='\n## 优先修正的缺口\n\n';for(const [title,body] of guide.gaps)text+='- **'+title+'：** '+body+'\n';
text+='\n## 组织、项目与个人\n\n项目和个人是多对多关系。组织共识、项目日报和个人视图从同一批项目主账条目生成，不另造组织共识主账；任务、作业、结果与验收继续由相应系统维护。偏好需要本人来源与适用范围；未知就写未知。登记人数不等于去重后的组织人数或活跃用户数。\n\n';
text+='PMO 指跨项目协调与推进的职责。Agent 持续核对进展、发现遗漏和依赖、比较重复工作、提取好方法并提出建议。人确认目标与取舍、自己的承诺和现实验收。没有日志不等于没有工作；进度百分比必须有明确里程碑、分母和验收依据。\n\n';
text+=table([['信息字段','保存什么'],['---','---'],...guide.recordFields])+'\n\n';
text+=table([['确认职责','确认内容'],['---','---'],...guide.roles])+'\n\n确认绑定条目版本。实质修改后，相关确认重新核对；无回应不等于认可。明确的普通事实可以自动查证，不要求所有人逐条点击。工作流发现允许一例有用实践，活动 Skill 晋升另需真实独立复用证据。\n\n';
text+='## 落地顺序与验收\n\n';for(const p of guide.phases)text+='### '+p.label+'\n\n'+p.enabled+'\n\n'+p.disabled+'\n\n验收：'+p.accept+'\n\n';
text+='### 测试隔离\n\n'+guide.isolation+'\n\n';
text+='### 迁移现有结构\n\n';for(const [title,body] of guide.migration)text+='- **'+title+'：** '+body+'\n';
text+='\n### 场景验收\n\n';for(const [title,body] of guide.acceptanceCases)text+='- **'+title+'：** '+body+'\n';
text+='\n### 实施前补齐的信息\n\n';for(const [title,body] of guide.prerequisites)text+='- **'+title+'：** '+body+'\n';
text+='\n本次沿原链路接入匹配项目指针与日报增强规则；未扩展业务执行、投递目标、个人偏好或公司信息。\n\n';
text+=table([['最终效果','评估内容'],['---','---'],...guide.metrics])+'\n\n';
text+='## 与现有机制、成熟产品的比较\n\n'+guide.comparison.conclusion+'\n\n'+guide.comparison.evidence+'\n\n';
text+=table([['比较项','现有机制','拟实施方案'],['---','---','---'],...guide.comparison.rows])+'\n\n';
for(const p of guide.comparison.products){
  text+='### '+p.label+'\n\n'+p.position+'\n\n';
  for(const [title,body] of p.rows)text+='- **'+title+'：** '+body+'\n';
  text+='\n依据：'+p.sources.map(([title,url])=>'['+title+']('+url+')').join('、')+'。\n\n';
}
for(const [title,body] of guide.comparison.lessons)text+='- **'+title+'：** '+body+'\n';
text+='\n### 前台与后台的成本\n\n'+graphSection(guide.costGraph);
for(const [title,body] of guide.costRules)text+='- **'+title+'：** '+body+'\n';
text+='\n### token 演示账本（不是实测）\n\n'+guide.tokenExample.boundary+'\n\n'+guide.tokenExample.formula+'\n\n';
const example=calculateTokenScenario(Object.fromEntries(guide.tokenExample.fields.map(f=>[f.id,f.value])));
text+=table([['演示输入项','假设值'],['---','---'],...guide.tokenExample.fields.map(f=>[f.label,f.value])])+'\n\n以上初始假设：当前 '+example.current.toLocaleString('zh-CN')+' token／日，治理后 '+example.proposed.toLocaleString('zh-CN')+'；净新增后台 '+example.extraBackground.toLocaleString('zh-CN')+'。'+(example.cheaperFrom===null?'前台每任务量没有降低，无法靠复用降低本式总量。':'每天至少 '+example.cheaperFrom+' 次使用才使总量更低。')+'交互网页可更改全部假设；不同模型、缓存与真实价格需另核算。\n\n';
for(const [label,rows] of [['如何验证',guide.evaluation],['测量字段（待增加或补齐）',guide.measurementFields],['真实使用中的观察与调优要求',guide.releaseGates],['失败与纠正',guide.failureRules]]){
  text+='### '+label+'\n\n';for(const [title,body] of rows)text+='- **'+title+'：** '+body+'\n';text+='\n';
}
text+='## 全范围增强、回退与待验证效果（v2.4）\n\n'+guide.preoperation.finding+'\n\n'+guide.preoperation.current+'\n\n';
for(const [label,rows] of [['这一轮的风险',guide.preoperation.risks],['已经执行与验证',guide.preoperation.controls],['后续实际接入条件',guide.preoperation.next]]){
  text+='### '+label+'\n\n';for(const [title,body] of rows)text+='- **'+title+'：** '+body+'\n';text+='\n';
}
text+=guide.preoperation.tool+'\n\n'+guide.preoperation.boundary+'\n\n';
text+='## 当前依据\n\n';for(const r of guide.references){
  const revision=r.revision || (/^(chat|lib|connectors|scripts)\//.test(r.path)?guide.mainBaseline:'main');
  text+='- ['+r.title+'](https://github.com/Ninglo/remotelab/blob/'+revision+'/'+r.path+')：'+r.use+'。\n';
}
text+='\n## 外部参考\n\n';for(const r of guide.external)text+='- ['+r.title+']('+r.url+')：'+r.use+'\n';
text+='\n## 维护\n\n';for(const t of guide.maintenance)text+='- '+t+'\n';
text+='\n编辑 '+inline('guide-data.js')+' 后运行 '+inline('node docs/memory-architecture/render-reference.mjs')+'；用 '+inline('--check')+' 检查参考文本是否同步。发布仅包括 '+inline('index.html')+'、'+inline('style.css')+'、'+inline('app.js')+'、'+inline('guide-data.js')+' 和 '+inline('README.md')+'。本章由 '+inline('docs/architecture-atlas/assemble-site.mjs')+' 纳入整体说明的 '+inline('memory/')+' 子目录；后续统一发布和备份，不另外维护平行网站。\n';
if(process.argv.includes('--check')){
  if(await readFile(target,'utf8')!==text)throw new Error('Reference text differs from guide-data.js; regenerate it.');
  console.log('Reference text matches shared content source.');
}else{await writeFile(target,text);console.log('Generated '+target);}
