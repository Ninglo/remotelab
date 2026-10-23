// Prepare changes for the instance-owned supervision site; never alter the live site.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Supervision source changed; review the integration anchor: ' + before.slice(0, 100));
  return source.replace(before, after);
}
export function partitionSupervisionSources({ app, collector, server }) {
  app = "import './group-participation.js';\n" + app;
  app = once(app, "return `<div class=\"type-tabs\">${(s.dashboard?.days||[])",
    "return (s.dashboard?.responseScope==='ordinary-input' ? globalThis.RemoteLabAgentDashboard.groupMonitoringHtml(s.dashboard?.groupParticipation,d.day)+`<h2>普通会话响应性能</h2><p class=\"meta\">首响候选 ${num(d.originCoverage?.ordinary)}；剔除原始群主线 ${num(d.originCoverage?.groupMainline)}、来源未知 ${num(d.originCoverage?.unknown)}。请求来源回退 ${num(d.originCoverage?.requestFallback)}。按输入归属计时，追加输入的回复不提前根输入首响；同次执行首次可见输出是另一项口径。</p>` : '<h2>会话响应性能</h2><p class=\"meta\">当前快照尚未分区，等待新版本统计数据。</p>')+`<div class=\"type-tabs\">${(s.dashboard?.days||[])");
  // Retain the existing all-time cost report and its 00:00 accounting window.
  // The activity panel's Run totals are a 05:00, seven-day subset, not a second ledger.
  app = once(app, "metric('首回应均值',ms(stats.mean)", "metric(s.dashboard?.responseScope==='ordinary-input'?'普通会话首回应均值':'首回应均值',ms(stats.mean)");
  collector = once(collector, "'todayActiveSessions','documents']", "'todayActiveSessions','documents','responseScope','groupParticipation']");
  server = once(server, "'/style.css','/feature-trials.js'", "'/style.css','/feature-trials.js','/group-participation.js'");
  return { 'public/app.js': app, 'collect.mjs': collector, 'server.mjs': server };
}
export async function prepareSupervisionPartition(siteRoot, outputDir) {
  if (resolve(siteRoot) === resolve(outputDir)) throw new Error('Prepare in a separate directory; live-site writes are not performed');
  const [app, collector, server, renderer, style, sharedStyle] = await Promise.all([
    readFile(join(siteRoot, 'public/app.js'), 'utf8'), readFile(join(siteRoot, 'collect.mjs'), 'utf8'),
    readFile(join(siteRoot, 'server.mjs'), 'utf8'), readFile(new URL('../../static/chat/agent-monitor-dashboard.js', import.meta.url), 'utf8'),
    readFile(join(siteRoot, 'public/style.css'), 'utf8'), readFile(new URL('../../static/chat/agent-monitor-dashboard.css', import.meta.url), 'utf8'),
  ]);
  const groupStyles = sharedStyle.slice(sharedStyle.indexOf('/* Group input monitoring */'));
  if (!groupStyles.startsWith('/* Group input monitoring */')) throw new Error('Group monitoring styles unavailable');
  const files = { ...partitionSupervisionSources({ app, collector, server }), 'public/group-participation.js': renderer,
    'public/style.css': style + '\n' + groupStyles };
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(outputDir, path, '..'), { recursive: true });
    await writeFile(join(outputDir, path), body);
  }
  return Object.keys(files);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [site, output] = process.argv.slice(2);
  if (!site || !output) throw new Error('Usage: node supervision-partition.mjs <existing-site> <separate-output-directory>');
  console.log(JSON.stringify(await prepareSupervisionPartition(site, output)));
}
