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
const diagram = `<div class="assembly-map" aria-label="上下文装配导航">
<div><h3>来源原件</h3><p>Markdown 模板<br>代码生成器 / 常量</p></div><span aria-hidden="true">→</span>
<div><h3>按条件组装</h3><p>首次 / 续聊 · 渠道<br>个人开关 · 任务状态</p></div><span aria-hidden="true">→</span>
<div><h3>实际模型输入</h3><p>RemoteLab 提示词<br>＋ Harness 历史与规则</p></div></div>`;
const navigation = `<div class="block-map">${blocks.map((b, i) => `<a href="#${b.id}"><span class="part">0${i + 1} · ${escape(b.when)}</span><strong>${escape(b.title)}</strong><span>${format(b.observedChars)} 字符 · 查看原文与压缩对照 ↓</span></a>`).join('')}</div>`;
const comparison = `<div class="table-scroll" tabindex="0" aria-label="五块长度对照，可横向滚动"><table><thead><tr><th>块</th><th>审计样本</th><th>草案正文</th><th>变化</th></tr></thead><tbody>${blocks.map(b => `<tr><td><a href="#${b.id}">${escape(b.title)}</a></td><td>${format(b.observedChars)}</td><td>${format(b.draftChars)}</td><td>−${((1 - b.draftChars / b.observedChars) * 100).toFixed(1)}%</td></tr>`).join('')}<tr><th>五块合计</th><td>${format(originalTotal)}</td><td>${format(draftTotal)}</td><td>−${reduction}%</td></tr></tbody></table></div>`;
const sourceLegend = '原文由核对版本的模板或生成函数生成；实例路径已改为通用路径。原始审计字符数与本页脱敏展开长度分别显示。当前快照、压缩草案和线上生效状态明确分开。';
const blockSections = blocks.map((b, i) => `<section id="${b.id}" class="prompt-section">
<span class="part">0${i + 1} · ${escape(b.when)}</span><h2>${escape(b.title)}</h2><p>${escape(b.what)}</p>
<p class="metadata">审计样本 ${format(b.observedChars)} 字符 · 本页通用展开 ${format(b.renderedChars)} 字符 · 草案 ${format(b.draftChars)} 字符</p>
<dl class="assessment"><dt>有必要保留什么</dt><dd>${escape(b.keep)}</dd><dt>哪里偏重或重复</dt><dd>${escape(b.repeat)}</dd><dt>如何有效压缩</dt><dd>${escape(b.change)}</dd></dl>
<p class="source-links">维护原件：${b.sources.map(file => sourceLink(file)).join(' · ')}<br>组装位置：<code>${escape(b.symbol)}</code></p>
<div class="text-pair"><details id="${b.id}-original"><summary>读当前原文 · ${format(b.renderedChars)} 字符</summary><pre>${escape(b.original)}</pre></details>
<details id="${b.id}-draft"><summary>读压缩草案 · ${format(b.draftChars)} 字符 · 未启用</summary><pre>${escape(b.draft)}</pre></details></div>
<p class="back"><a href="#map">返回导航地图 ↑</a></p></section>`).join('\n');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>RemoteLab · 上下文注入导航与压缩</title><meta name="description" content="直接读五块上下文提示词的原文、维护来源、注入条件和压缩草案。"><link rel="stylesheet" href="./guide.css?v=20261012context"><link rel="stylesheet" href="./context-injection.css?v=20261012context"><script type="module" src="./guide-shell.js?v=20261012context"></script></head>
<body data-guide-page="context-injection.html"><main>
<header id="scope" class="hero"><p class="eyebrow">上下文 · 来源导航 · 可审查草案</p><h1>模型每轮读到的规则，<br>分别从哪里来？</h1><p class="lead">这五块共 ${format(originalTotal)} 字符。关键契约需要保留，但完整目录、重复说明和操作手册不必全部常驻。</p><p>沿下面的地图可直接读当前原文，再看每块的必要性和压缩草案。原文已嵌入本页，无需先登录代码仓库。</p><p class="metadata">核对：${data.date} · 规则源码 ${data.sourceRevision.slice(0, 8)} · 本次只更新说明，未改变运行提示词或个人开关。</p><p class="guide-callout">草案正文合计 ${format(draftTotal)} 字符，较五块样本减少 ${reduction}%。这是静态文字量对照，部分内容改为按需读取；尚未验证语义等价、模型遵循率、token、时延或任务成功率。</p></header>
<section id="map"><h2>从地图进入五块原文</h2>${diagram}${navigation}<p>这不是五份启动时整篇读取的业务文档：显示规则是 Markdown；开工检查与任务卡规则是代码中的文本；启动目录和飞书规则是按条件生成的内容。路径只被写进提示词，不代表路径对应文档已加载。</p><p>组装总入口：${sourceLink('chat/session-manager.mjs', 'session-manager · buildManagerTurnContextSlots / buildPromptPackage')}；真正的来源背景和指针由 ${sourceLink('chat/turn-context-hook.mjs', 'turn-context-hook')} 提供。<a href="./project.html#startup">回到消息全程中的“开工上下文”</a>。</p></section>
<section id="comparison"><h2>能压缩，但不能只按字数删</h2>${comparison}<p>单位为 JavaScript 字符长度（UTF-16），不是 token。样本五块共 ${format(originalTotal)} 字符；当轮 RemoteLab 全部注入 19,877 字符，另含消息背景、回复设置、话题约定及包装。首次启动目录只在新原生线程追加，其余四块按适用条件每轮组装。</p><p>${sourceLegend}</p><p>先消除同一规则的多处版本，再缩短措辞：显示块和个人设置合成唯一有效契约；任务卡具体操作沿工具帮助读取；严格检查保留四项责任；飞书块只保留渠道特有信息。不能用截断末尾的方式压掉授权、回复归属或验收要求。</p></section>
${blockSections}
<section id="boundaries"><h2>这张地图之外，还有什么上下文？</h2><ul><li>人员／项目指针、当前来源背景、Session 约定、任务状态和个人回复设置仍有独立块；本页没有把它们算进五块合计。</li><li>原生 Harness 的规则、技能目录、工具定义和历史不由本页完整捕获；后续文件读取、检索响应和附件会继续增加上下文。</li><li>新线程补充启动目录，续聊使用原生历史，重建线程可能带摘要／历史续接包。飞书话题的聊天背景还可能与线程里已有内容重叠。</li><li>既有原生线程仍可能记得旧版提示词。改代码只影响新准备的输入，不能从历史里自动抹除旧规则。</li></ul><p>继续阅读：${sourceLink('docs/connector-turn-context.md', '各场景注入与十月清理边界')} · ${sourceLink('docs/session-work-awareness.md', '相关工作检索与工作登记')} · <a href="./memory/index.html">记忆如何保存与接续</a>。</p></section>
<section id="verification"><h2>压缩前后怎样验收</h2><ol><li>逐条核对保留的行为契约，标明移至按需读取的内容；不能仅靠字符串相似或字数判断等价。</li><li>覆盖首次／续聊、飞书群／话题／私聊／文档评论、开关开／关、不同发言人、已有任务／简单问题和执行中补充输入。</li><li>验证回复仍回原地址、补充问题有单独答案、卡片不重复、手动展开状态保留、历史不被当作新授权、完成仍有证据。</li><li>固定同一模型和任务集，对比 token、缓存、首次可见回复、总时长、任务验收与返工。按需读回的额外开销也必须算进去。</li></ol><p>建议先做确定性的条件裁剪与跨块去重，再试正文压缩。当前页面提供可逐条审查的草案，不宣称已经实现运行收益。</p></section>
<section id="maintenance"><h2>来源与维护</h2><p>规则原件继续维护在上面列出的源文件；本页说明和草案维护在 <code>docs/architecture-atlas/context-injection.json</code>，由 <code>render-context-injection.mjs</code> 生成 HTML 和参考文本。生成器核对规则源码版本；规则发生变化时必须重新核对、更新基线并生成。</p><p>公开页只展示通用规则，不含人员档案、群消息、凭据、Run 原始快照或私有项目正文。阅读本页不会改变设置或调用实例私有接口。</p><p><a href="./project.html">返回整体说明</a> · <a href="./context-injection.md">同源参考文本</a> · <a href="./deliverables.html#pages">说明页面总目录</a></p></section>
</main></body></html>\n`;
const markdown = ['# 上下文注入导航与压缩', '', `核对 ${data.date}；规则源码 ${data.sourceRevision}。只更新说明，未修改运行提示词。`, '',
  `五块样本共 ${originalTotal} 字符；草案 ${draftTotal} 字符，减少 ${reduction}%。仅为文字量对照，不代表等价或收益已验证。`, '', sourceLegend, '',
  ...blocks.flatMap(b => [`## ${b.title}`, '', b.what, '', `触发：${b.when}。样本 ${b.observedChars} 字符；通用展开 ${b.renderedChars}；草案 ${b.draftChars}。`, '',
    `保留：${b.keep}`, '', `重复：${b.repeat}`, '', `压缩：${b.change}`, '', ...b.sources.map(file => `来源：[${file}](https://github.com/Ninglo/remotelab/blob/${data.sourceRevision}/${file})`), '',
    '### 当前通用展开', '', '```text', b.original, '```', '', '### 草案（未启用）', '', '```text', b.draft, '```', '']),
  '## 验收与范围', '', '五块之外仍有当前背景、任务状态、回复设置、Harness 原生上下文和工具读取。首次启动与续聊不同；字符不等于 token。压缩必须验证来源与回复归属、权限、重复卡片、开关变更和任务验收；按需读回成本也计入比较。', '',
  '[交互阅读与完整导航](context-injection.html)', ''].join('\n');
await writeFile(path.join(dir, 'context-injection.html'), html);
await writeFile(path.join(dir, 'context-injection.md'), markdown);
console.log(JSON.stringify({ blocks: blocks.map(({ id, observedChars, renderedChars, draftChars }) => ({ id, observedChars, renderedChars, draftChars })), originalTotal, draftTotal, reduction }));
