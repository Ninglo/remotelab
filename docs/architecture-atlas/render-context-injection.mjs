import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemContext } from '../../chat/system-prompt.mjs';
import { strictStartCheckPrompt } from '../../chat/strict-start-check.mjs';
import { WORKBOARD_INSTRUCTIONS } from '../../lib/workboard-context.mjs';
import { buildSourceRuntimePrompt } from '../../chat/source-runtime-prompts.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const data = JSON.parse(await readFile(path.join(dir, 'context-injection.json'), 'utf8'));
const exec = promisify(execFile);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const format = n => n.toLocaleString('en-US');
const sourceLink = (file, label = file) => `<a href="https://github.com/Ninglo/remotelab/blob/${data.sourceRevision}/${file}">${escape(label)}</a>`;
// Fail rather than silently attaching an old source revision to newly edited rules.
for (const file of new Set(data.blocks.flatMap(block => block.sources))) {
  const current = await readFile(path.join(root, file), 'utf8');
  const { stdout } = await exec('git', ['show', `${data.sourceRevision}:${file}`], { cwd: root, maxBuffer: 2 ** 22 });
  if (current !== stdout) throw new Error(`Update the verified context sourceRevision before rendering: ${file}`);
}
const originals = {
  startup: await buildSystemContext(),
  surface: (await readFile(path.join(root, 'chat/prompt-assets/system/surface-messages.md'), 'utf8')).trim(),
  strict: strictStartCheckPrompt({ scope: 'person', strictStartCheck: true }),
  workboard: WORKBOARD_INSTRUCTIONS,
  feishu: buildSourceRuntimePrompt({ sourceId: 'feishu', sourceName: 'Feishu', sourceContext: { chatType: 'group' } }),
};
const normalizePublicPaths = text => text
  .replace(/^(- Shared system memory: ).*$/m, '$1$REMOTELAB_PROJECT_ROOT/memory/system.md')
  .replace(/\/home\/[^/\s`]+/g, '~');
const blocks = data.blocks.map(block => {
  const original = normalizePublicPaths(originals[block.id]);
  if (/\b(?:person_|identity_|run_|om_x|oc_)[a-f0-9]{12}/.test(original)) throw new Error('Private identifier in public prompt snapshot');
  return { ...block, original, renderedChars: original.length, draftChars: block.draft.length };
});
const originalTotal = blocks.reduce((n, b) => n + b.observedChars, 0);
const draftTotal = blocks.reduce((n, b) => n + b.draftChars, 0);
const reduction = ((1 - draftTotal / originalTotal) * 100).toFixed(1);
const currentChars = b => b.status === '本轮收束' ? b.renderedChars : b.observedChars;
const currentTotal = blocks.reduce((n, b) => n + currentChars(b), 0);
const changed = blocks.filter(b => b.status === '本轮收束');
if (changed.reduce((n, b) => n + b.observedChars, 0) !== data.round.before || changed.reduce((n, b) => n + b.renderedChars, 0) !== data.round.after) throw new Error('Update round measurements for the current source');
const diagram = `<div class="assembly-map" aria-label="上下文装配导航">
<div><h3>来源原件</h3><p>Markdown 模板<br>代码生成器 / 常量</p></div><span aria-hidden="true">→</span>
<div><h3>按条件组装</h3><p>首次 / 续聊 · 渠道<br>个人开关 · 任务状态</p></div><span aria-hidden="true">→</span>
<div><h3>实际模型输入</h3><p>RemoteLab 提示词<br>＋ Harness 历史与规则</p></div></div>`;
const navigation = `<div class="block-map">${blocks.map((b, i) => `<a href="#${b.id}"><span class="part">0${i + 1} · ${escape(b.when)}</span><strong>${escape(b.title)}</strong><span>${format(b.observedChars)} 字符（初次样本） · 查看当前原文 ↓</span></a>`).join('')}</div>`;
const comparison = `<div class="table-scroll" tabindex="0" aria-label="五块长度对照，可横向滚动"><table><thead><tr><th>块</th><th>初次样本</th><th>本轮口径</th><th>处理</th></tr></thead><tbody>${blocks.map(b => `<tr><td><a href="#${b.id}">${escape(b.title)}</a></td><td>${format(b.observedChars)}</td><td>${format(currentChars(b))}</td><td>${escape(b.status)}</td></tr>`).join('')}<tr><th>同一五块组合</th><td>${format(originalTotal)}</td><td>${format(currentTotal)}</td><td>减少 ${format(originalTotal - currentTotal)} 字符</td></tr></tbody></table></div>`;
const sourceLegend = '原文由核对版本的模板或生成函数生成；实例路径已改为通用路径。原始审计字符数与本页脱敏展开长度分别显示。当前快照、压缩草案和线上生效状态明确分开。';
const blockSections = blocks.map((b, i) => `<section id="${b.id}" class="prompt-section">
<span class="part">0${i + 1} · ${escape(b.when)}</span><h2>${escape(b.title)}</h2><p>${escape(b.what)}</p>
<p class="metadata">审计样本 ${format(b.observedChars)} 字符 · 本页通用展开 ${format(b.renderedChars)} 字符 · 初次草案 ${format(b.draftChars)} 字符（归档）</p>
<dl class="assessment"><dt>有必要保留什么</dt><dd>${escape(b.keep)}</dd><dt>哪里偏重或重复</dt><dd>${escape(b.repeat)}</dd><dt>如何有效压缩</dt><dd>${escape(b.change)}</dd></dl>
<p class="source-links">维护原件：${b.sources.map(file => sourceLink(file)).join(' · ')}<br>组装位置：<code>${escape(b.symbol)}</code></p>
<div class="text-pair"><details id="${b.id}-original"><summary>读当前原文 · ${format(b.renderedChars)} 字符</summary><pre>${escape(b.original)}</pre></details>
<details id="${b.id}-draft"><summary>读初次探索草案 · ${format(b.draftChars)} 字符 · 归档未启用</summary><pre>${escape(b.draft)}</pre></details></div>
<p class="back"><a href="#map">返回导航地图 ↑</a></p></section>`).join('\n');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>RemoteLab · 上下文注入导航与压缩</title><meta name="description" content="直接读五块上下文提示词的原文、维护来源、注入条件和压缩草案。"><link rel="stylesheet" href="./guide.css?v=20261012display"><link rel="stylesheet" href="./context-injection.css?v=20261012display"><script type="module" src="./guide-shell.js?v=20261012display"></script></head>
<body data-guide-page="context-injection.html"><main>
<header id="scope" class="hero"><p class="eyebrow">上下文 · 来源导航 · 第一轮收束</p><h1>模型每轮读到的规则，<br>分别从哪里来？</h1><p class="lead">先收束最容易重复的显示与清单规则：${format(data.round.before)} → ${format(data.round.after)} 字符，减少 ${data.round.reduction}%。</p><p>沿下面的地图可直接读当前源码中的原文，再看本轮边界与历史草案。原文已嵌入本页，无需先登录代码仓库。</p><p class="metadata">核对：${data.date} · 规则源码 ${data.sourceRevision.slice(0, 8)} · ${escape(data.round.status)}</p><p class="guide-callout">${escape(data.round.summary)} 两块合计减少${format(data.round.before-data.round.after)}字符，不等于token、耗时或费用同幅下降。</p></header>
<section id="map"><h2>从地图进入五块原文</h2>${diagram}${navigation}<p>这不是五份启动时整篇读取的业务文档：显示规则是 Markdown；开工检查与任务卡规则是代码中的文本；启动目录和飞书规则是按条件生成的内容。路径只被写进提示词，不代表路径对应文档已加载。</p><p>组装总入口：${sourceLink('chat/session-manager.mjs', 'session-manager · buildManagerTurnContextSlots / buildPromptPackage')}；真正的来源背景和指针由 ${sourceLink('chat/turn-context-hook.mjs', 'turn-context-hook')} 提供。<a href="./project.html#startup">回到消息全程中的“开工上下文”</a>。</p></section>
<section id="comparison"><h2>本轮改了哪里，哪些保持原样</h2>${comparison}<p>单位为 JavaScript 字符长度（UTF-16），不是 token。初次五块组合是开启个人严格检查的特定请求，不是所有人的固定基线。本轮保留未改块的原样本计数，只替换两块文本长度，得到${format(currentTotal)}字符；不是新请求的完整上下文实测。初次当轮 RemoteLab 全部注入 19,877 字符，另含消息背景、回复设置、话题约定及包装。首次启动目录只在新原生线程追加，其余四块按适用条件每轮组装。</p><p>${sourceLegend}</p><p>本轮按职责合并重复说明：显示块负责开场、进展、补充答复、最终答复与展开选择；清单块负责触发、操作、证据和状态。实现上保留两个条件块，未调整个人偏好、未增加工具帮助检索。最初“整体减少66.4%”草案已归档，不再作为实施目标。</p></section>
${blockSections}
<section id="boundaries"><h2>这张地图之外，还有什么上下文？</h2><ul><li>人员／项目指针、当前来源背景、Session 约定、任务状态和个人回复设置仍有独立块；本页没有把它们算进五块合计。</li><li>原生 Harness 的规则、技能目录、工具定义和历史不由本页完整捕获；后续文件读取、检索响应和附件会继续增加上下文。</li><li>新线程补充启动目录，续聊使用原生历史，重建线程可能带摘要／历史续接包。飞书话题的聊天背景还可能与线程里已有内容重叠。</li><li>既有原生线程仍可能记得旧版提示词。改代码只影响新准备的输入，不能从历史里自动抹除旧规则。</li></ul><p>继续阅读：${sourceLink('docs/connector-turn-context.md', '各场景注入与十月清理边界')} · ${sourceLink('docs/session-work-awareness.md', '相关工作检索与工作登记')} · <a href="./memory/index.html">记忆如何保存与接续</a>。</p></section>
<section id="verification"><h2>压缩前后怎样验收</h2><ol><li>逐条核对保留的行为契约，标明移至按需读取的内容；不能仅靠字符串相似或字数判断等价。</li><li>覆盖首次／续聊、飞书群／话题／私聊／文档评论、开关开／关、不同发言人、已有任务／简单问题和执行中补充输入。</li><li>验证回复仍回原地址、补充问题有单独答案、卡片不重复、手动展开状态保留、历史不被当作新授权、完成仍有证据。</li><li>固定同一模型和任务集，对比 token、缓存、首次可见回复、总时长、任务验收与返工。按需读回的额外开销也必须算进去。</li></ol><p>本轮已做文本去重与职责收束，提示词组装、个人隔离、回复投递、清单状态与补丁等现有回归通过；这些确定性检查不证明模型遵循率或任务质量。后续效果仍需同任务对照。</p></section>
<section id="maintenance"><h2>来源与维护</h2><p>规则原件继续维护在上面列出的源文件；本页说明和草案维护在 <code>docs/architecture-atlas/context-injection.json</code>，由 <code>render-context-injection.mjs</code> 生成 HTML 和参考文本。生成器核对规则源码版本；规则发生变化时必须重新核对、更新基线并生成。</p><p>公开页只展示通用规则，不含人员档案、群消息、凭据、Run 原始快照或私有项目正文。阅读本页不会改变设置或调用实例私有接口。</p><p><a href="./project.html">返回整体说明</a> · <a href="./context-injection.md">同源参考文本</a> · <a href="./deliverables.html#pages">说明页面总目录</a></p></section>
</main></body></html>\n`;
const markdown = ['# 上下文注入导航与压缩', '', `核对 ${data.date}；规则源码 ${data.sourceRevision}。${data.round.status}`, '',
  `本轮显示与清单 ${data.round.before} → ${data.round.after} 字符（−${data.round.reduction}%）。${data.round.summary} 初次五块组合是个人开启严格检查的样本，不是公共默认。最初整体压缩草案已归档，不作为实施目标。`, '', sourceLegend, '',
  ...blocks.flatMap(b => [`## ${b.title}`, '', b.what, '', `触发：${b.when}。样本 ${b.observedChars} 字符；通用展开 ${b.renderedChars}；草案 ${b.draftChars}。`, '',
    `保留：${b.keep}`, '', `重复：${b.repeat}`, '', `压缩：${b.change}`, '', ...b.sources.map(file => `来源：[${file}](https://github.com/Ninglo/remotelab/blob/${data.sourceRevision}/${file})`), '',
    '### 当前通用展开', '', '```text', b.original, '```', '', '### 初次探索草案（归档，未启用）', '', '```text', b.draft, '```', '']),
  '## 验收与范围', '', '五块之外仍有当前背景、任务状态、回复设置、Harness 原生上下文和工具读取。首次启动与续聊不同；字符不等于 token。压缩必须验证来源与回复归属、权限、重复卡片、开关变更和任务验收；按需读回成本也计入比较。', '',
  '[交互阅读与完整导航](context-injection.html)', ''].join('\n');
await writeFile(path.join(dir, 'context-injection.html'), html);
await writeFile(path.join(dir, 'context-injection.md'), markdown);
console.log(JSON.stringify({ blocks: blocks.map(({ id, observedChars, renderedChars, draftChars }) => ({ id, observedChars, renderedChars, draftChars })), originalTotal, currentTotal, round: data.round, archivedDraft: { draftTotal, reduction } }));
