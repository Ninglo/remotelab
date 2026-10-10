import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-topic-memory-'));
setIsolatedTestHome(home);
const memoryDir = join(home, '.remotelab/memory');
const ledger = join(home, 'project-knowledge/projects.md');
const index = join(home, 'project-knowledge/project-index.md');
await mkdir(join(memoryDir, 'tasks'), { recursive: true });
await mkdir(join(memoryDir, 'reference/people'), { recursive: true });
await mkdir(join(home, 'project-knowledge'), { recursive: true });
const config = { schemaVersion: 1, enabled: true, contextEnabled: true, reviewEnabled: true, releaseId: 'v1',
  indexPath: index, ledgerPath: ledger, workflowPath: join(home, 'workflow.md'),
  projects: [{ id: 'workbench' }], groups: [], sessionBindings: [] };
const configPath = join(memoryDir, 'project-runtime.json');
const originalQuery = '副屏现在连接在Mac Mini上了，但是我希望它能显示我这台电脑的内容，能做到吗';
try {
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(index, '# 项目索引\n\n| workbench | 工作台 | [主账](projects.md) |');
  await writeFile(join(memoryDir, 'projects.md'), '# 领域导航\n\n- 副屏局部记录：[设备](tasks/display.md)');
  await writeFile(join(memoryDir, 'tasks/index.md'), '# 任务导航');
  await writeFile(join(memoryDir, 'skills.md'), '# 方法导航');
  await writeFile(join(memoryDir, 'tasks/display.md'), '# Secondary display\n\n副屏已有工作区、提醒区、陪伴区；Mac Mini 负责播放，账号内容通过网络获取。');
  await writeFile(ledger, '# 工作台主账\n\n## 设备历史\n\n副屏早期只显示 USB 接入状态。\n\n副屏后来采用工作、提醒和陪伴三个区域；天气、飞书与 To do 已接入。\n\n工牌项目暂停，副屏是独立事项，不自动恢复工牌。\n\nMac Mini 接在这台电脑上，录音工具能做到原音上传。\n\n迁机历史中的 WebSocket 曾可用，不能据此认领这次程序任务。');
  await writeFile(join(memoryDir, 'reference/people/other.md'), '副屏私人偏好，不可跨人加载');
  const { readNecessaryBackground, retrieveNecessaryContext } = await import('../chat/necessary-background.mjs');
  const { readTopicMemory } = await import('../chat/topic-memory-context.mjs');
  const topic = (await readNecessaryBackground({ id: 'fresh-unbound' }, { memoryDir, configPath, query: originalQuery }))
    .coverage.find(entry => entry.kind === 'topic-memory');
  assert.match(topic.excerpts.map(entry => entry.text).join('\n'), /工作区、提醒区、陪伴区/,
    'the original one-topic question reads the later background before asking the person to repeat it');
  assert.equal(topic.authority, 'reference-only'); assert.equal(topic.association, 'not-inferred');
  assert(topic.excerpts.every(entry => entry.hash && entry.lineStart && entry.lineEnd >= entry.lineStart));
  assert(!topic.sources.some(entry => entry.path.includes('/people/')));
  assert(!topic.excerpts.some(entry => /录音工具/.test(entry.text)), 'incidental host overlap does not displace the named topic');
  const project = (await readNecessaryBackground({}, { memoryDir, configPath, query: originalQuery }))
    .coverage.find(entry => entry.kind === 'project');
  assert.equal(project.result, 'no-confirmed-association', 'search does not assign an unbound Session to a project');
  const retrieved = await retrieveNecessaryContext({}, { memoryDir, configPath, query: originalQuery });
  assert.match(retrieved.context, /工作区、提醒区、陪伴区/, 'the explicit tool uses the same original-source reader');
  const unrelated = await readTopicMemory({ memoryDir, projectConfig: config, query: '修改 WebSocket 程序' });
  assert.deepEqual(unrelated.excerpts, [], 'unrelated requests get no device body');
  const tiny = await readTopicMemory({ memoryDir, projectConfig: config, query: '副屏', maxChars: 1 });
  assert.equal(tiny.result, 'budget-skipped'); assert(tiny.omittedCount > 0);
  await writeFile(join(memoryDir, 'tasks/display.md'), '# Secondary display\n\n副屏更正：账号内容无需桌面共享；原先桌面投屏的判断已撤销。');
  const changed = await readTopicMemory({ memoryDir, projectConfig: config, query: '副屏' });
  const current = changed.excerpts.find(entry => entry.path.endsWith('/tasks/display.md'));
  assert.match(current.text, /已撤销/);
  assert.notEqual(current.hash, topic.excerpts.find(entry => entry.path === current.path).hash);
  const disabled = await readTopicMemory({ memoryDir, projectConfig: { ...config, contextEnabled: false }, query: '副屏' });
  assert(!disabled.sources.some(entry => entry.path === ledger), 'project body follows its existing context switch');
  await writeFile(join(home, 'secret.md'), '副屏外部凭据禁止读取');
  await symlink(join(home, 'secret.md'), join(memoryDir, 'tasks/unsafe.md'));
  await writeFile(join(memoryDir, 'projects.md'), '# 导航\n\n副屏：[符号链接](tasks/unsafe.md) [越界](../../secret.md)');
  const escaped = await readTopicMemory({ memoryDir, projectConfig: config, query: '副屏' });
  assert(!escaped.excerpts.some(entry => /外部凭据/.test(entry.text)));
  assert(escaped.sources.some(entry => entry.status === 'outside-registered-regions'));
  await writeFile(ledger, '副屏'.repeat(530000));
  const oversized = await readTopicMemory({ memoryDir, projectConfig: config, query: '副屏' });
  assert(oversized.sources.some(entry => entry.path === ledger && entry.status === 'too-large-or-not-file'));
  const { buildTurnContextHook } = await import('../chat/turn-context-hook.mjs');
  await writeFile(ledger, '# 主账\n\n副屏三区是工作、提醒、陪伴；当前设置应回读实际配置。');
  const hook = await buildTurnContextHook({ id: 'fresh' }, { query: originalQuery });
  assert.doesNotMatch(hook, /副屏三区是工作、提醒、陪伴|Necessary background/, 'fresh turns do not automatically retrieve topic bodies');
  const resumed = await buildTurnContextHook({ id: 'resumed', codexThreadId: 'old-thread' }, { query: originalQuery });
  assert.doesNotMatch(resumed, /副屏三区是工作、提醒、陪伴|Necessary background/, 'native resume also keeps topic retrieval explicit');
  const explicit = await retrieveNecessaryContext({ id: 'fresh' }, { query: originalQuery });
  assert.match(explicit.context, /副屏三区是工作、提醒、陪伴/, 'explicit retrieval still discovers original topic passages');
  console.log('TOPIC_MEMORY_VERIFIED: explicit fresh/unbound query, original excerpts and versions, no automatic fresh/resumed body injection, whole-passage budgets, corrections, switches and bounded path/read failures.');
} finally { await rm(home, { recursive: true, force: true }); }
