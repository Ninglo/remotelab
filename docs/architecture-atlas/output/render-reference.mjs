import { writeFile } from 'node:fs/promises';
import { meta, references, nodes, overviewGraphs, sequences, actors, questionLevels, states, rollout, contracts, invariants, openings } from './guide-data.js';

const lines = [
  '# RemoteLab 消息与任务输出架构规划', '',
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
  '现状中的 Jev 分别承担群表情与分流、清单 Gate 及独立 Auto 档位选择。目标输出主线取消对它的依赖，Auto 另行评估。复用原生输入、停止和事件；MCP Events 属于外部订阅，不自动提供本页业务规则。', '',
  '- 内容源为 `guide-data.js`。图、时序、体验示例与改动验收引用同一份内容。',
  '- 修改后运行 `node render-reference.mjs` 同步本参考文本，并核对桌面、窄屏、键盘操作及全部场景。',
  '- 公开内容不包含私人消息、用户身份、群 ID、Session ID、凭据或带 token 的链接。',
  '- 发布前递归扫描静态文件；发布后以未登录浏览器确认实际页面与导航可访问。',
  '- 本页规划交付与消息机制开发部署分别验收；不以网站发布宣称业务改动上线。', '');
await writeFile(new URL('./README.md',import.meta.url),lines.join('\n'));
console.log('规划参考文本已由图示内容源生成。');
