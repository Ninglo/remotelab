import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const [project, catalog, historical] = await Promise.all([
  readJson('docs/architecture-atlas/project.json'),
  readJson('docs/architecture-atlas/features.json'),
  readJson('feature_list.json'),
]);
const inventory = project.deliverables;
if (!inventory || !/^[a-f0-9]{40}$/.test(inventory.sourceRevision)) throw new Error('Deliverables need a verified source revision in project.json');
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const sourceUrl = file => `https://github.com/Ninglo/remotelab/blob/${inventory.sourceRevision}/${file}`;
const sourceLink = file => `<a href="${escape(sourceUrl(file))}"><code>${escape(file)}</code></a>`;
const candidates = catalog.groups.flatMap(group => group.features);
const pages = project.pages.filter(page => page.chapter !== 'deliverables');
const chapters = project.chapters.filter(chapter => chapter.id !== 'deliverables');
const sourceFiles = [...new Set(candidates.flatMap(feature => feature.sources))].sort();
const historyFiles = ['feature_list.json', 'progress.txt', 'CHANGELOG.md'];
for (const file of new Set([...sourceFiles, ...inventory.documents.map(doc => doc.path), ...historyFiles])) {
  if (path.isAbsolute(file) || file.split('/').includes('..')) throw new Error(`Invalid source path: ${file}`);
  await access(path.join(root, file));
}
for (const page of pages) {
  const chapter = chapters.find(item => item.id === page.chapter);
  const file = chapter?.source === 'docs/memory-architecture'
    ? path.join(root, chapter.source, path.posix.basename(page.route))
    : path.join(directory, page.route);
  await access(file);
}
const counts = { featureGroups: catalog.groups.length, featureCandidates: candidates.length, referencedSourceFiles: sourceFiles.length, explanationPages: pages.length, selectedDocuments: inventory.documents.length, historicalRecords: historical.length };
const scope = `本章在 ${inventory.checkedAt} 定位了 ${counts.featureGroups} 组、${counts.featureCandidates} 项候选功能及其 ${counts.referencedSourceFiles} 个源码或文档引用，${counts.explanationPages} 个原有说明页面、${counts.selectedDocuments} 个重点文档入口，以及 ${counts.historicalRecords} 条旧功能记录。数量分别描述不同对象，不能相加当作已完成成果总数。`;
const boundary = `本次核对到文件、目录和引用存在。功能清单沿用 ${catalog.checkedAt} 的候选记录，模块作者补漏与逐项实际使用验收尚未完成；历史目录也可能含已调整的入口。某项功能的当前启用、结果送达与业务效果，需要继续沿原记录查证。`;
const provenance = `源码核对基线 ${inventory.sourceRevision}。页面、功能与文档保留各自的核对日期，本章整理日期不替代它们。`;
const sectionTitles = { sessions: '会话与历史接续', execution: '执行、配置与验收', automation: '自动工作、日历与待办', connections: '消息和办公接入', delivery: '文件、分享与预览', devices: '本地助手与设备', 'people-memory': '人员、记忆与设置', operations: '监控、安装与运维' };
const capabilityHtml = catalog.groups.map(group => {
  const sources = [...new Set(group.features.flatMap(feature => feature.sources))];
  return `<article class="feature-row" id="deliverable-${escape(group.id)}"><h3>${escape(sectionTitles[group.id] || group.title)}</h3><div><p>${escape(group.intro)}</p><p>${group.features.map(feature => `<a href="features.html#${escape(feature.id)}">${escape(feature.name)}</a>`).join(' · ')}</p><p class="feature-condition">${group.features.length} 项候选入口；代码与说明已定位，实际启用及验收范围见原条目。</p><details data-technical><summary>对应的代码和文档（${sources.length} 个引用）</summary><p>${sources.map(sourceLink).join(' · ')}</p></details></div></article>`;
}).join('\n');
const pageRows = pages.map(page => {
  const chapter = chapters.find(item => item.id === page.chapter);
  return `<tr><td><a href="${escape(page.route)}">${escape(page.route === project.entry ? '消息全程与总入口' : page.route.endsWith('reference.html') ? '执行与交付的参考图' : chapter?.title || page.route)}</a></td><td>${escape(chapter?.description || '沿一条消息查系统环节，再进入各章。')}</td><td>页面已存在；专题实现与验收边界见原章。</td></tr>`;
}).join('');
const documentRows = inventory.documents.map(doc => `<tr><td><a href="${escape(sourceUrl(doc.path))}">${escape(doc.name)}</a></td><td>${escape(doc.purpose)}</td><td><code>${escape(doc.path)}</code></td></tr>`).join('');
const historyRows = [
  ['feature_list.json', `${historical.length} 条功能与验证标记；包含 description、pass，以及部分 verification_plan／rollout。`, `最后更新于 ${inventory.historyCheckedThrough}。pass 是旧记录中的标记，不代表当前功能与部署全部通过验收。`],
  ['progress.txt', '开发过程、验证结果、上线或暂缓上线的文字记录。', `最后更新于 ${inventory.historyCheckedThrough}。需按具体条目区分本地验证、线上核对和暂缓启用。`],
  ['CHANGELOG.md', '按版本汇总的产品变化。', '包含历史版本与 Unreleased；不是所有交付的完整现状目录。'],
].map(([file, purpose, status]) => `<tr><td>${sourceLink(file)}</td><td>${escape(purpose)}</td><td>${escape(status)}</td></tr>`).join('');
const maintenance = [
  '功能与使用说明更新 features.json；实际代码与专用文档仍在原文件维护。',
  '说明页面和本章重点文档入口更新 project.json；新增章节继续加入同一个项目。',
  '重新生成本章并组装原网站，更新同一个发布入口；生成的 HTML 与参考文本不手工维护第二份正文。',
  '项目决定、责任与进度沿原项目记录核对；本章提供成果入口，不另维护一份记忆或任务状态。',
];
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RemoteLab 产出汇总</title><link rel="stylesheet" href="./guide.css?v=${project.edition}"><link rel="stylesheet" href="./features.css?v=${project.edition}"><script type="module" src="./guide-shell.js?v=${project.edition}"></script></head>
<body data-guide-page="deliverables.html"><main>
<header id="scope" class="hero"><p class="eyebrow">RemoteLab 整体说明 · 产出汇总</p><h1>我们已经做出了什么</h1><p class="lede">从现有项目记录找到功能、代码、页面和文档，沿原来源继续核对和使用。</p><p>${escape(scope)}</p><p>${escape(boundary)}</p><p class="metadata">${escape(provenance)}</p></header>
<section id="capabilities"><h2>功能与代码</h2><p>已有功能按原清单的用途归组。名称链接到使用入口、条件和例子，展开后可定位实现；本章不复制另一套功能正文。</p>${capabilityHtml}</section>
<section id="pages"><h2>说明页面</h2><p>这些页面已经归在同一个 RemoteLab 整体说明项目中。本章也是其中一章，共用目录、发布包和备份。</p><div class="feature-table"><table><thead><tr><th>页面入口</th><th>可以查什么</th><th>核对到哪一步</th></tr></thead><tbody>${pageRows}</tbody></table></div></section>
<section id="documents"><h2>项目文档</h2><p>先列最常用的解释与维护入口。文档存在说明材料已定位，功能启用条件和实际验收仍读原文；更多专用资料从文档导航继续查。</p><div class="feature-table"><table><thead><tr><th>文档</th><th>用途</th><th>原维护位置</th></tr></thead><tbody>${documentRows}</tbody></table></div></section>
<section id="history"><h2>找回的历史记录</h2><p>仓库根目录里确实保留了早期功能和交付记录。目前能确认它们仍在，不能确认讨论中提到的“几个月前整理的那一份”就是这些文件，也没有据此确认它们持续自动更新。</p><div class="feature-table"><table><thead><tr><th>原文件</th><th>记录了什么</th><th>时间与状态</th></tr></thead><tbody>${historyRows}</tbody></table></div><details data-technical><summary>旧功能记录的稳定 ID（${historical.length} 条）</summary><p>${historical.map(item => `<code>${escape(item.id)}</code>`).join(' · ')}</p></details></section>
<section id="maintenance"><h2>如何继续维护</h2><ol>${maintenance.map(item => `<li>${escape(item)}</li>`).join('')}</ol><details data-technical><summary>生成与组装入口</summary><pre><code>node docs/architecture-atlas/render-deliverables.mjs
node docs/architecture-atlas/assemble-site.mjs &lt;新的空输出目录&gt;</code></pre><p>本章数据从项目目录、功能清单与旧交付记录读取。正常读取入口是原项目目录；生成结果不写入启动记忆、人员档案或另一个独立成果文档。</p></details></section>
</main></body></html>\n`;
const markdown = [
  '# RemoteLab 产出汇总', '', scope, '', boundary, '', provenance, '',
  '本页是整体说明项目的生成章节；内容修改原项目记录后重新生成。', '',
  '## 功能与代码', '',
  ...catalog.groups.flatMap(group => [`### ${sectionTitles[group.id] || group.title}`, '', group.intro, '', ...group.features.map(feature => `- [${feature.name}](features.html#${feature.id})`), '', `代码与说明：${[...new Set(group.features.flatMap(feature => feature.sources))].map(file => `[${file}](${sourceUrl(file)})`).join('、')}`, '']),
  '## 说明页面', '', ...pages.map(page => `- [${page.route}](${page.route})`), '',
  '## 项目文档', '', ...inventory.documents.map(doc => `- [${doc.name}](${sourceUrl(doc.path)})：${doc.purpose}`), '',
  '## 找回的历史记录', '',
  `- [feature_list.json](${sourceUrl('feature_list.json')})：${historical.length} 条旧功能与验证标记；最后更新于 ${inventory.historyCheckedThrough}，不代表当前部署全部验收。`,
  `- [progress.txt](${sourceUrl('progress.txt')})：开发、验证、上线或暂缓上线记录；最后更新于 ${inventory.historyCheckedThrough}。`,
  `- [CHANGELOG.md](${sourceUrl('CHANGELOG.md')})：历史版本与 Unreleased 变化，不是完整现状目录。`, '',
  '尚不能确认这些文件就是讨论中提到的那份更早记录，也没有确认其持续自动更新。', '',
  '## 如何继续维护', '', ...maintenance.map((item, index) => `${index + 1}. ${item}`), '',
  '```sh', 'node docs/architecture-atlas/render-deliverables.mjs', 'node docs/architecture-atlas/assemble-site.mjs <新的空输出目录>', '```', '',
].join('\n');
await writeFile(path.join(directory, 'deliverables.html'), html);
await writeFile(path.join(directory, 'deliverables.md'), markdown);
console.log(JSON.stringify({ projectId: project.id, ...counts, sourceRevision: inventory.sourceRevision }));
