import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const data = JSON.parse(await readFile(path.join(directory, 'features.json'), 'utf8'));
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const github = (file, revision = data.sourceRevision) => `https://github.com/Ninglo/remotelab/blob/${revision}/${file}`;
const features = data.groups.flatMap(group => group.features);
const ids = [ ...data.groups.map(group => group.id), ...features.map(feature => feature.id) ];
if (new Set(ids).size !== ids.length || ids.some(id => !/^[a-z][a-z0-9-]*$/.test(id))) throw new Error('Feature and group IDs must be unique, stable anchors');
if (!/^[a-f0-9]{40}$/.test(data.sourceRevision)) throw new Error('Use an exact verified source revision');
for (const feature of features) {
  for (const field of ['name', 'purpose', 'entry', 'condition', 'example']) {
    if (!feature[field]) throw new Error(`Missing ${field}: ${feature.id}`);
  }
  if (feature.sourceRevision && !/^[a-f0-9]{40}$/.test(feature.sourceRevision)) throw new Error('Use an exact feature source revision');
  if (!feature.sources.length) throw new Error(`Missing sources: ${feature.id}`);
}
for (const file of new Set(features.flatMap(feature => feature.sources))) {
  if (file.startsWith('/') || file.split('/').includes('..')) throw new Error(`Invalid source path: ${file}`);
  await access(path.join(root, file));
}
const cli = await readFile(path.join(root, 'cli.js'), 'utf8');
const help = cli.split('function printHelp()')[1].split('switch (command)')[0];
const commands = [...help.matchAll(/remotelab ([a-z][a-z-]*)\s/g)].map(match => match[1]);
const represented = new Set(features.flatMap(feature => feature.commands));
const missing = commands.filter(command => !represented.has(command));
const unexpected = [...represented].filter(command => !commands.includes(command));
if (missing.length || unexpected.length) throw new Error(`CLI mapping: missing ${missing.join(', ')}; unexpected ${unexpected.join(', ')}`);
const sourceLinks = feature => feature.sources.map(file => `<a href="${github(file, feature.sourceRevision)}"><code>${escape(file)}</code></a>`).join(' · ');
const renderFeature = feature => `<article class="feature-row" id="${feature.id}"><h3>${escape(feature.name)}</h3><div><p>${escape(feature.purpose)}</p><p><strong>入口：</strong>${escape(feature.entry)}</p><p class="feature-condition"><strong>使用条件：</strong>${escape(feature.condition)}</p><details data-technical><summary>使用例子与维护线索</summary><p>可以这样说：“${escape(feature.example)}”</p><p>${sourceLinks(feature)}</p>${feature.commands.length ? `<p>Agent 入口：${feature.commands.map(command => `<code>remotelab ${escape(command)}</code>`).join('、')}。具体参数查当前实例的帮助。</p>` : ''}</details></div></article>`;
const groups = data.groups.map(group => `<section id="${group.id}"><h2>${escape(group.title)}</h2><p>${escape(group.intro)}</p>${group.features.map(renderFeature).join('\n')}</section>`).join('\n');
const commandRows = commands.map(command => {
  const entries = features.filter(feature => feature.commands.includes(command));
  return `<tr><td><code>${escape(command)}</code></td><td>${entries.map(feature => `<a href="#${feature.id}">${escape(feature.name)}</a>`).join('、')}</td></tr>`;
}).join('');
const confirmed = data.groups.filter(group => group.authorReview === 'confirmed').length;
const reviewRows = data.groups.map(group => `<tr><td><a href="#${group.id}">${escape(group.title)}</a></td><td>${escape(group.author || '待确认')}</td><td>${escape(group.maintainer || '待确认')}</td><td>${group.authorReview === 'confirmed' ? '已有明确确认记录' : '尚未收到模块确认'}</td></tr>`).join('');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(data.title)} · RemoteLab</title><link rel="stylesheet" href="./guide.css?v=${data.edition}"><link rel="stylesheet" href="./features.css?v=${data.edition}"><script type="module" src="./guide-shell.js?v=${data.edition}"></script></head>
<body data-guide-page="features.html"><main>
<header id="scope" class="hero"><p class="eyebrow">RemoteLab 整体说明 · ${escape(data.status)}</p><h1>${escape(data.title)}</h1><p class="lede">先按要做的事找能力，再看入口和使用条件。</p><p>这份清单帮助大家使用现有功能，也让模块作者有一份能逐项补漏的底稿。<strong>完整性和负责人尚未经过作者确认，不能把它称为完整说明书。</strong></p><p class="metadata">${data.checkedAt} 核对 · ${data.groups.length} 组、${features.length} 项候选功能 · ${commands.length} 个主 CLI 命令已对应到条目 · ${confirmed}/${data.groups.length} 组收到作者确认</p><p>${escape(data.scope)}</p><p>本章加入设置页原有的“RemoteLab 整体说明”，与消息全程、系统、执行和记忆章节共用目录。<a href="./project.html?v=${data.edition}">回到整体说明</a>。</p><details data-technical><summary>本轮核对的版本与运行范围</summary><p>源码基线：<a href="https://github.com/Ninglo/remotelab/tree/${data.sourceRevision}"><code>${data.sourceRevision}</code></a>。</p><ul>${data.observations.map(item => `<li>${escape(item)}</li>`).join('')}</ul></details></header>
<section id="start"><h2>先从哪个入口用</h2><p>日常工作从会话开始：给目标、样例和约束，需要文件就说明要下载什么。已有工作沿原会话继续。监控器用于查看运行与自动化，设置用于人员、连接和界面选项。</p><p>没有菜单的能力也可以直接在会话里提出要求，例如创建日历事件、更新个人待办、配置录音或发布网页。Agent 应先查本实例的绑定和使用条件；本章中的命令是维护线索，不要求普通用户到机器上逐条执行。</p><p>每项功能的使用例子和源码依据可在“使用例子与维护线索”中展开。下面的功能属于已见入口盘点，仍要经作者确认有没有遗漏。</p></section>
${groups}
<section id="monitor-fleet"><h2>monitor 和 fleet 各负责什么</h2><p>界面中的“监控器”（Monitor）有自动化列表和运行总览。总览把本实例的账号额度、用量台账、磁盘、自动化、已登记服务和紧急问题放在一起，帮助判断当前工作有没有受到影响。</p><p>Fleet Observer 是独立项目，负责跨机器收集账号和额度、按身份去重、保存来源和历史，并提供受限的账号管理操作。RemoteLab 可读取它已配置的脱敏快照；两边看见同一份额度，可能来自同一个采集来源。</p><p>所以查当前实例工作是否受影响，先看 RemoteLab 总览；查跨机器采集关系和独立监控账号管理，再看 fleet 的对应入口。监控总览不会凭空获得全部机器覆盖，现有集成也不表示所有 fleet 操作都已迁入 RemoteLab。</p><details data-technical><summary>依据与覆盖边界</summary><p>${data.externalCapabilities.map(item => `${escape(item.name)}：${escape(item.purpose)} ${escape(item.boundary)}`).join('</p><p>')}</p><p>依据：${escape(data.externalCapabilities[0].source)}；<a href="${github('docs/monitoring.md')}">RemoteLab 监控原说明</a>。本章不发布私有账号清单、机器配置或实时余额。</p></details></section>
<section id="commands"><h2>对照命令检查有没有漏项</h2><p>这张表逐项对应本次源码 CLI 帮助中的 ${commands.length} 个主命令。它只证明这些命令已有说明条目，<strong>不证明所有功能都已找到</strong>：子操作、接口、连接器回调、独立脚本和外部项目仍需另核。</p><div class="feature-table"><table><thead><tr><th>主命令</th><th>对应功能</th></tr></thead><tbody>${commandRows}</tbody></table></div><details data-technical><summary>版本差异、别名与已移除入口</summary><p>根据 <a href="${github('cli.js')}">cli.js</a>，email、connectors、guest-instances、assistant-messages、triggers、schedules、spawn-session 是对应主命令的别名；帮助与版本参数另列。release 的分派仅返回已移除提示，不列为可用功能。API 的存在、某个脚本的存在和主命令数量都不能替代用户场景覆盖。</p><p>本机曾读到旧 PATH CLI；Agent 若遇到命令缺失，应先确认实例源码与版本，再按已核入口使用 <code>node "$REMOTELAB_PROJECT_ROOT/cli.js"</code>，不能因此认定能力不存在。</p></details></section>
<section id="review"><h2>由作者补漏并确认</h2><p>自动检索只能提供有依据的起点。请按实际参与编写或维护的模块检查条目，补入隐藏用法、使用条件和停用情况。最初作者与当前维护人分别记录；没有明确依据就继续保留未知。</p><p>目前 ${confirmed}/${data.groups.length} 组收到明确的模块确认。下面按盘点范围分组，不预设每组只属于一位作者，也没有自动给同事分配任务。</p><div class="feature-table"><table><thead><tr><th>盘点范围</th><th>最初作者</th><th>当前维护人</th><th>确认情况</th></tr></thead><tbody>${reviewRows}</tbody></table></div><h3>作者一次提供这些信息即可</h3><pre class="review-packet">${escape(data.reviewPacket.join('\n\n'))}</pre><p>回复可留在原讨论或该模块的既有记录中，再由维护者核对依据、更新本章的原内容源。真正的项目任务和人员责任继续在原主账维护；网页不能另造一份没有来源的责任表。</p><h3>本版仍缺什么</h3><ul>${data.gaps.map(item => `<li>${escape(item)}</li>`).join('')}</ul><p>收到补充后，先核对原入口、部署范围和实际示例，再更新对应条目与核对日期。新版本只有在这些缺口得到适当确认后，才能改变“盘点初稿”的标记。</p></section>
<footer class="guide-footer"><p>内容源：<code>docs/architecture-atlas/features.json</code>；HTML 与<a href="./features.md">参考文本</a>由 <code>render-features.mjs</code>生成。章节沿用整体说明的发布、备份与维护流程。</p><p><a href="./project.html?v=${data.edition}">消息全程</a> · <a href="./memory/index.html?v=${data.edition}">记忆与协作</a></p></footer>
</main></body></html>\n`;
const markdown = [`# ${data.title}`, '', `状态：${data.status}。核对日期：${data.checkedAt}。`, '',
  '这份清单是供使用和作者补漏的底稿。完整性和负责人尚未经过作者确认，不能称为完整说明书。', '', data.scope, '',
  `本轮源码基线：${data.sourceRevision}。${data.groups.length} 组、${features.length} 项候选功能；${commands.length} 个主 CLI 命令已有对应条目，${confirmed}/${data.groups.length} 组收到作者确认。`, '',
  ...data.groups.flatMap(group => [`## ${group.title}`, '', group.intro, '', ...group.features.flatMap(feature => [
    `### ${feature.name}`, '', feature.purpose, '', `入口：${feature.entry}`, '', `使用条件：${feature.condition}`, '',
    `可以这样说：“${feature.example}”`, '', `维护线索：${feature.sources.map(file => `[${file}](${github(file, feature.sourceRevision)})`).join('、')}。`, '',
    ...(feature.commands.length ? [`Agent 命令入口：${feature.commands.map(command => '`remotelab ' + command + '`').join('、')}。`, ''] : [])
  ])]), '## monitor 和 fleet', '',
  'RemoteLab 监控器的总览聚合本实例账号、用量、磁盘、自动化和已登记服务；Fleet Observer 跨机器采集账号额度、去重并保留来源及历史。RemoteLab 可读取配置好的 fleet 脱敏快照，现有集成不代表所有 fleet 管理功能已迁入 RemoteLab。', '',
  ...data.externalCapabilities.map(item => `${item.name}：${item.boundary}`), '', '## 待作者确认', '',
  ...data.gaps.map(item => `- ${item}`), '', '作者补漏输入：', '', '```text', ...data.reviewPacket, '```', '',
  '## CLI 覆盖对照', '', '| 主命令 | 对应功能 |', '| --- | --- |',
  ...commands.map(command => `| ${command} | ${features.filter(feature => feature.commands.includes(command)).map(feature => feature.name).join('、')} |`), '',
  '主命令覆盖只证明这些入口已对应条目，不证明所有功能都已找到。子操作、接口、连接器回调和仓库外能力仍需确认。', '',
  '## 核对范围', '', ...data.observations.map(item => `- ${item}`), '',
  '内容源为 features.json；运行 node docs/architecture-atlas/render-features.mjs 生成网页与本文。'
].join('\n') + '\n';
await writeFile(path.join(directory, 'features.html'), html);
await writeFile(path.join(directory, 'features.md'), markdown);
console.log(JSON.stringify({ groups: data.groups.length, features: features.length, cliCommands: commands.length, missingCommands: missing, authorConfirmedGroups: confirmed, sourceFilesVerified: new Set(features.flatMap(feature => feature.sources)).size }));
