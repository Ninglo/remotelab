import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lark } from './project-reading-sync.mjs';

// Kept outside the focused collector/index: overview content cannot enter its analysis inputs.
export async function collectOverview(plan, { output, profile, indexes, request = lark }) {
  await mkdir(output, { recursive: true });
  const rows = [];
  for (const source of plan.overviewSources || []) {
    const row = { chatId: source.chatId, chatName: source.chatName, readingLevel: 'overview', analysisEligible: false,
      method: '新增主线，最多50条；不展开话题、附件或表情', windowStart: source.windowStart, windowEnd: source.windowEnd };
    try {
      if (source.analysisEligible !== false || source.readingLevel !== 'overview') throw new Error('Invalid overview scope');
      if (indexes && plan.todoSources?.some(s => s.chatId === source.chatId && !s.projectAnalysisEligible)) {
        const indexPath = join(indexes, `index-${source.chatId}.json`);
        const index = JSON.parse(await readFile(indexPath, 'utf8'));
        if (!index.complete || index.chat_id !== source.chatId || index.windowEnd !== source.windowEnd) throw new Error('Incomplete shared Todo read');
        row.status = 'reused'; row.method = '复用本轮完整待办来源；项目分析资格保持不变';
        row.messageCount = Array.isArray(index.messages) ? index.messages.length : Object.keys(index.messages).length;
        row.evidencePath = indexPath; rows.push(row); continue;
      }
      const params = { container_id_type: 'chat', container_id: source.chatId, page_size: 50,
        sort_type: 'ByCreateTimeDesc', start_time: String(Date.parse(source.windowStart) / 1000), end_time: String(Date.parse(source.windowEnd) / 1000) };
      const data = await request(['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(params)], profile);
      // Raw OpenAPI has no implicit thread/resource enrichment.
      const body = data?.data || data;
      if (!Array.isArray(body.items)) throw new Error('Missing root-message items');
      row.messageCount = body.items.length; row.status = body.has_more ? 'sampled' : 'read';
      row.truncated = Boolean(body.has_more); row.expandedThreads = 0; row.attachmentsRead = 0;
      row.evidencePath = join(output, source.chatId + '.json');
      await writeFile(row.evidencePath, JSON.stringify({ ...row, evidenceRole: 'orientation_only_not_analysis_source', messages: body.items }, null, 2), { mode: 0o600 });
    } catch (e) { row.status = 'failed'; row.error = e.message; }
    rows.push(row);
  }
  const manifest = { scheduledAt: plan.scheduledAt, checkedAt: new Date().toISOString(), analysisEligible: false,
    sourcePurpose: '一般了解，不作项目结论、日报分析或待办判断信源', groups: rows };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a, []));
  for (const k of ['plan', 'profile', 'output']) if (!args[k]) throw new Error(`--${k} required`);
  const result = await collectOverview(JSON.parse(await readFile(args.plan, 'utf8')), args);
  const failed = result.groups.filter(g => g.status === 'failed').length;
  console.log(JSON.stringify({ groups: result.groups.length, failed, manifest: join(args.output, 'manifest.json') }));
  if (failed) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
