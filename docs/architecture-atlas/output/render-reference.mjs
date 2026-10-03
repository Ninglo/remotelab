import { writeFile } from 'node:fs/promises';
import { meta, references, nodes, overviewGraphs, sequences, actors, questionLevels, states, rollout, contracts, invariants, openings } from './guide-data.js';
import { audit, scenarios, actors as flowActors, feedback, testCases } from './flow-data.js';

const actorLabels = Object.fromEntries(flowActors.map(a => [a.id, a.label]));
const readerLines = [
  '# RemoteLab：一条消息如何变成工作和交付', '',
  `版本：${audit.version}。源码快照：\`${audit.commit}\`。`, '',
  '阅读入口：[当前流程与交接](index.html)；[目标图与交互演示附录](reference.html)。', '',
  audit.scope, '',
  '先可靠收录，再提交可执行 Request。写入 Session 观察历史不启动 Run；Jev 在部分入口参与前置快判，实际任务由 Harness 执行和验收。当前飞书新复杂任务完整收发仍待验收。即时表情前置、跨 Worker 到达顺序和问题分级仍待实施。', '',
  '## 当前流程与独立目标', '', '前置调用按依赖顺序推进；接纳后的模型、投递与后置支路并行，编号供阅读，不构成全局到达顺序保证。', '',
];
for (const scenario of Object.values(scenarios)) {
  readerLines.push(`### ${scenario.label}`, '', `${scenario.status}。${scenario.intro}`, '');
  scenario.steps.forEach((s, i) => readerLines.push(
    `#### ${i + 1}. ${s.title}`, '',
    `${actorLabels[s.from]} → ${actorLabels[s.to]}；承担者：${s.owner}；交接方式：${s.kind}。`, '',
    s.action, '', `交接：${s.handoff}`, '', `等待：${s.wait}`, '', `可见与证据：${s.visible}`, '',
  ));
}
readerLines.push('## 运行中用户反馈：当前与目标', '');
for (const [kind, current, goal] of feedback) readerLines.push(`### ${kind}`, '', `当前：${current}`, '', `目标：${goal}`, '');
readerLines.push('## 真实体验验收', '');
for (const [kind, check, boundary] of testCases) readerLines.push(`- **${kind}**：${check} 当前边界：${boundary}。`);
readerLines.push('', '## 下文是目标图与演示的维护参考', '',
  '以下时序、交互卡与状态扩展分别标明规划；不能把目标交互的演示当成当前所有入口的实现。真实路径、Jev 的串行等待以及 groupFeed 的卡片排除规则以上文为准。', '');

const lines = [
  ...readerLines,
  '## RemoteLab 消息与任务输出架构规划附录', '',
  `版本：${meta.version}。状态：${meta.status}。`, '', meta.boundary, '',
  '人类阅读入口：[交互架构网站](index.html)。本目录作为既有架构图谱的“消息与任务输出”专题，沿用其样式和证据边界；不把既有全站视图的旧基线改称最新。', '',
  '## 目标与职责边界', '',
  '用户能看到：消息已收到、Agent 是否开始、当前真实进展、是否等待自己、正式结果是否送达。主 Harness 理解任务、规划、调用工具、验收和形成用户内容；RemoteLab 保存请求与事件，负责恢复和跨表面投递。taskId 是 Session 内稳定工作卡的投影身份，不新增全局任务产品。', '',
  '## 目标图的承接节点', '',
];
for (const {ref} of overviewGraphs.target.nodes) {
  const n=nodes[ref];
  lines.push(`### ${n.title}`, '', `承担者：${n.owner}。复用 / 改动状态：${n.status}。`, '', n.summary, '',
    `- 输入：${n.input}`,`- 输出 / 下一承接者：${n.output}`,`- 持久记录：${n.stored}`,`- 异步与恢复：${n.async}`,`- 事实边界：${n.evidence}`, '',
    `源码：${references[n.refs].map(path=>'`'+path+'`').join('、')}。`, '');
}
lines.push('## 开场为什么有信息量', '', `仅复述：${openings.weak}`, '', `已有事实与判断：${openings.useful}`, '',openings.rule,'');
lines.push('## 异步时序', '');
const labels=Object.fromEntries(actors.map(a=>[a.id,a.label]));
for(const seq of Object.values(sequences)){
  lines.push(`### ${seq.label}`,'',seq.lead,'');
  seq.steps.forEach(([from,to,title,detail],i)=>lines.push(`${i+1}. ${labels[from]} → ${labels[to]}：${title}。${detail}。`));
  lines.push('');
}
lines.push('## 用户反馈与提问', '',
  '明确停止优先；结构化问题答案核对任务、题号、对象与版本；其他自由文本进入原生会话，由主 Harness 理解。停止不能被当自定义答案。插问直接回答并继续原任务；补充被收录不等于已采用，采用后具体说明变化；纠正标准后重新验收。独立新目标说明旧任务安排。暂停等待明确继续，取消不自行重启。正式交付前的关键纠正先校验，交付后续作保留版本记录。','');
for(const level of questionLevels)lines.push(`- **${level.label}**：${level.behavior} 未回复：${level.silence}。`);
lines.push('','当前普通选择题五分钟后默认首项；该现状不满足必要输入与授权的分级目标。必要待答任务可释放本次执行，但持久保留问题；稍后答案续接同一卡片。','');
lines.push('## 三种独立状态','');
for(const lane of states)lines.push(`- **${lane.label}**：${lane.states.join(' → ')}。维护者：${lane.owner}。${lane.meaning}`);
lines.push('','## 交接契约（规划名称，非现行 API）','');
for(const item of contracts)lines.push('- `'+item.name+'`：'+item.writer+' 写入 '+item.fact+'；'+item.consumer+' 消费。'+item.status+'。');
lines.push('','## 改动与真实入口验收','');
for(const item of rollout)lines.push(`### ${item.title}`,'',`承担者：${item.owner}。`,'',`现状：${item.now}`,'',`改动：${item.change}`,'',`验收：${item.acceptance}`,'');
lines.push('## 不变边界','');
for(const item of invariants)lines.push('- '+item);
lines.push('','## 源码与维护','','主线源码底座：`'+meta.mainCommit+'`；本次核对的试验实例：`'+meta.pilotCommit+'`。', '',
  '现状中的 Jev 仍承担群表情与分流及独立 Auto 档位选择；任务卡入口已取消其 gate，由执行 Harness 判断实际工作量。接收确认前置与问题分级仍待实施，Auto 另行评估。复用原生输入、停止和事件；MCP Events 属于外部订阅，不自动提供本页业务规则。', '',
  '- 内容源为 `guide-data.js`。图、时序、体验示例与改动验收引用同一份内容。',
  '- 修改后运行 `node render-reference.mjs` 同步本参考文本，并核对桌面、窄屏、键盘操作及全部场景。',
  '- 公开内容不包含私人消息、用户身份、群 ID、Session ID、凭据或带 token 的链接。',
  '- 发布前递归扫描静态文件；发布后以未登录浏览器确认实际页面与导航可访问。',
  '- 本页规划交付与消息机制开发部署分别验收；不以网站发布宣称业务改动上线。', '');
await writeFile(new URL('./README.md',import.meta.url),lines.join('\n'));
console.log('规划参考文本已由图示内容源生成。');
