// On-demand, authenticated file names and locations; never read private bodies
// or execute a connector registry refresh while rendering this inventory.
import { readdir, lstat, open, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { CONFIG_DIR, MEMORY_DIR, SYSTEM_MEMORY_DIR, MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';
import { loadMemoryWritebackTargets } from './memory-writeback-targets.mjs';

export async function readMemoryFileCatalog({ memoryDir = MEMORY_DIR, configDir = CONFIG_DIR,
  systemDir = SYSTEM_MEMORY_DIR, workRoot = MANAGED_WORK_ROOT_DIR, projectConfig } = {}) {
  const files = [], issues = [];
  let visited = 0, truncated = false;
  async function walk(root, region, depth = 0) {
    if (depth > 4 || truncated) { truncated = true; return; }
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { issues.push({ path: root, status: error.code === 'ENOENT' ? 'not-recorded' : 'unavailable' }); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 600) { truncated = true; break; }
      if (entry.name.startsWith('.') || ['archive', 'logs', 'session-learnings'].includes(entry.name)) continue;
      const path = join(root, entry.name);
      if (entry.isDirectory()) await walk(path, region, depth + 1);
      else if (entry.isFile() && /\.(md|json)$/.test(entry.name)) files.push({ name: entry.name, path, region });
      // Do not follow directory or file symlinks in a catalogue scan.
    }
  }
  await walk(memoryDir, '实例记忆');
  async function fixed(path, region, note = '') {
    let status = 'available';
    let resolvedPath;
    try { const stat = await lstat(path); if (stat.isSymbolicLink()) resolvedPath = await realpath(path); }
    catch (error) { status = error.code === 'ENOENT' ? 'not-recorded' : 'unavailable'; }
    files.push({ name: path.split('/').at(-1), path, region, status, note,
      ...(resolvedPath ? { resolvedPath } : {}) });
  }
  await Promise.all([
    fixed(join(workRoot, 'AGENTS.md'), '公共规则', '可能是符号链接；不存员工偏好'),
    fixed(join(dirname(systemDir), 'AGENTS.md'), '仓库规则'),
    fixed(join(systemDir, 'system.md'), '跨部署知识'),
    fixed(join(systemDir, 'auto-system-memory.md'), '跨部署候选'),
    fixed(join(configDir, 'auth.json'), '人员与产品设置', '只列位置，不读取凭据或设置正文'),
    fixed(join(configDir, 'chat-sessions.json'), 'Session 元数据'),
  ]);
  const patterns = [
    [join(configDir, 'chat-history', '<sessionId>', 'meta.json'), 'Session 摘要索引'],
    [join(configDir, 'chat-history', '<sessionId>', 'context.json'), 'Session 续接上下文'],
    [join(configDir, 'chat-history', '<sessionId>', 'fork-context.json'), '分支来源上下文'],
    [join(configDir, 'chat-history', '<sessionId>', 'events', '<seq>.json'), '消息与事件；不是 events.jsonl'],
    [join(configDir, 'chat-history', '<sessionId>', 'bodies', '<ref>.txt'), '事件正文'],
    [join(configDir, 'chat-runs', '<runId>', '{manifest,status,result}.json'), '运行记录'],
    [join(configDir, 'chat-runs', '<runId>', 'spool.jsonl'), '原生输出流'],
    [join(memoryDir, 'archive', '<归档批次>', '<原文件名>'), '历史原文；不恢复为默认指令'],
  ].map(([path, note]) => ({ path, note }));
  if (projectConfig) {
    await Promise.all([fixed(projectConfig.indexPath, '项目导航'), fixed(projectConfig.ledgerPath, '项目主账'),
      fixed(projectConfig.workflowPath, '当前审阅规则'), fixed(join(dirname(projectConfig.workflowPath), 'chronology.json'), '项目进程视图')]);
    patterns.push({ path: join(dirname(projectConfig.ledgerPath), 'daily', '<YYYY-MM-DD>.md'), note: '日期日报投影' });
  }
  let registry;
  try {
    const handle = await open(join(configDir, 'feishu-bots.json'), 'r');
    try {
      if ((await handle.stat()).size <= 256 * 1024) registry = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch { /* Registry availability is separate from connector health. */ }
  for (const bot of (Array.isArray(registry?.bots) ? registry.bots : []).slice(0, 16)) {
    if (typeof bot.storageDir !== 'string') continue;
    for (const file of ['events.jsonl', 'connector-message-index.json', 'project-message-streams/<项目hash>.jsonl']) {
      patterns.push({ path: join(bot.storageDir, file), note: '已登记连接器来源位置；本清单不验证采集覆盖' });
    }
  }
  let writeback;
  try { writeback = (await loadMemoryWritebackTargets()).map(({ id, path, layer, categories }) => ({ id, path, layer, categories })); }
  catch { issues.push({ status: 'writeback-catalog-unavailable' }); }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), patterns, writeback, issues, truncated,
    boundary: 'Names and locations only. Excludes archive contents, logs, hidden files, symlinks and provider-native history. Existing files are not all accepted/current knowledge; patterns describe variable filenames.' };
}
