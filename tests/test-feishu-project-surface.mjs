import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-project-surface-'));
setIsolatedTestHome(home);
const surfaces = [];
try {
  const { createProjectSurface } = await import('../connectors/feishu/project-surface.mjs');
  const { projectMemorySection, taskVersion } = await import('../connectors/feishu/project-sources.mjs');
  const { handleMessage } = await import('../scripts/feishu-connector.mjs');
  const memoryPath = join(home, 'projects.md');
  const registryPath = join(home, 'project-sources.json');
  const auditPath = join(home, 'audit.json');
  const taskId = `sch_${'a'.repeat(24)}`;
  const registry = { schema: 1, projects: { example: {
    name: 'Example', memory: { path: memoryPath, heading: '## Project' },
    tasks: [{ id: taskId, alias: 'daily', scope: '与其他项目共用，暂停影响所有关联项目' }],
    resources: [{ name: '原讨论', url: 'https://example.com/source' }],
    materials: [{ alias: 'memory-audit', name: '原记忆审计', path: auditPath, fields: { status: '实施状态', preserve: '保留部分' } }],
  } } };
  await writeFile(registryPath, JSON.stringify(registry));
  await writeFile(auditPath, JSON.stringify({ status: 'proposal_not_implemented', preserve: ['原控制面'], privateField: 'DO NOT SHOW' }));
  await writeFile(memoryPath, '# Ledger\n\n## Project\n\nOriginal fact\n\n## Other\n\nPRIVATE OTHER PROJECT');
  assert.throws(() => projectMemorySection('## Project\n## Project', '## Project'), /重复/);
  const runtime = { config: { storageDir: join(home, 'state'), projectSurfacesPath: registryPath,
    sourceRouteId: 'fixture', accessPolicy: { mode: 'open' }, responsePolicy: { group: 'all' },
    projectLinks: [{ projectId: 'example', discussionChatId: 'discussion', workChatId: 'work' }] },
    storagePaths: {} };
  let task = { id: taskId, title: 'Daily', state: 'active', enabled: true, prompt: 'Read original sources',
    schedule: { type: 'cron', cron: '0 4 * * *', timezone: 'Asia/Shanghai', missedCount: 0 },
    runtime: { runtimePolicy: 'auto' }, actions: ['pause', 'cancel'] };
  const requests = [];
  let failAfterWrite = false;
  runtime.requestRemoteLab = async (path, options) => {
    requests.push({ path, options });
    if (options?.method === 'POST') {
      if (path.endsWith('/pause')) { task.state = 'paused'; task.actions = ['resume', 'cancel']; }
      else if (path.endsWith('/resume')) { task.state = 'active'; task.actions = ['pause', 'cancel']; }
      else throw new Error('Unexpected mutation');
      if (failAfterWrite) { failAfterWrite = false; throw new Error('Network outcome uncertain'); }
    }
    return { response: { ok: true }, json: { task: structuredClone(task) } };
  };
  let card;
  let created = 0;
  let patches = 0;
  let failReply = false;
  const sent = new Map();
  let onPatch;
  runtime.appClient = { im: { v1: { message: {
    reply: async ({ data }) => {
      if (!sent.has(data.uuid)) { sent.set(data.uuid, 'card-id'); created++; }
      card = JSON.parse(data.content);
      if (failReply) { failReply = false; throw new Error('Lost send acknowledgement'); }
      return { code: 0, data: { message_id: sent.get(data.uuid) } };
    },
    patch: async ({ data }) => { card = JSON.parse(data.content); patches++; onPatch?.(); return { code: 0 }; },
  } } } };
  const options = { authorize: async summary => summary.sender.openId === 'allowed', watchFiles: false };
  const makeSurface = extra => { const surface = createProjectSurface(runtime, { ...options, ...extra });
    surfaces.push(surface); return surface; };
  let surface = makeSurface();
  const summary = { chatId: 'discussion', chatType: 'group', messageType: 'text',
    messageId: 'human-message', threadId: 'topic', sender: { senderType: 'user', openId: 'allowed' } };
  const content = () => JSON.stringify(card);
  const values = () => card.body.elements.flatMap(element => element.columns || [])
    .flatMap(column => column.elements || []).flatMap(element => element.behaviors || []).map(behavior => behavior.value);
  const event = value => ({ context: { open_chat_id: 'discussion', open_message_id: 'card-id' },
    operator: { operator_id: { open_id: 'allowed' } }, action: { value } });
  const choose = (action, alias) => event(values().find(value => value.action === action && (!alias || value.alias === alias)));

  failReply = true;
  await assert.rejects(surface.command(summary), /Lost send/);
  await surface.command(summary);
  assert.equal(created, 1, 'uncertain sends reuse the original source and provider UUID');
  await surface.command({ ...summary, messageId: 'later-human-message' });
  assert.equal(created, 1, 'one card per project conversation');
  assert(content().includes('原讨论'));
  await surface.command(summary, 'material memory-audit');
  assert(content().includes('方案尚未实施'));
  assert(!content().includes('DO NOT SHOW'), 'materials expose only explicitly registered fields');
  await writeFile(auditPath, JSON.stringify({ status: 'completed', preserve: ['原控制面'] }));
  await surface.refresh();
  assert(content().includes('本项已完成'), 'audit material reads are also bound to their original source');
  await surface.command(summary, 'memory');
  assert(content().includes('Original fact'));
  assert(!content().includes('PRIVATE OTHER PROJECT'), 'only the explicitly registered section is exposed');
  await writeFile(memoryPath, '# Ledger\n\n## Project\n\nCorrected fact\n\n## Other\n\nPRIVATE OTHER PROJECT');
  await surface.refresh();
  assert(content().includes('Corrected fact'), 'the view reads authoritative memory, not a synchronized copy');
  const correction = await surface.command(summary, 'memory 请纠正负责人，保留原来源');
  assert(correction.taskText.includes(memoryPath));
  assert(correction.taskText.includes('用户原文：\n请纠正负责人'));
  assert((await readFile(memoryPath, 'utf8')).includes('Corrected fact'), 'submitting a correction is not an unverified memory write');

  await surface.command(summary, 'tasks');
  const pause = choose('pause', 'daily');
  assert.equal((await surface.actionFeedback(pause)).accepted, true);
  for (const invalid of [
    { ...pause, context: { ...pause.context, open_chat_id: 'foreign-chat' } },
    { ...pause, context: { ...pause.context, open_message_id: 'forwarded-message' } },
    { ...pause, operator: { operator_id: { open_id: 'denied' } } },
    event({ ...pause.action.value, alias: 'unregistered' }),
  ]) assert.equal((await surface.actionFeedback(invalid)).accepted, false);
  task.schedule.missedCount++;
  assert.equal(taskVersion(task), pause.action.value.taskVersion, 'scheduler counters do not change configuration version');
  task.prompt = 'Changed elsewhere';
  await surface.handleAction(pause);
  assert.equal(requests.filter(call => call.options?.method === 'POST').length, 0, 'stale configuration clicks do not write');
  assert(content().includes('配置已发生变化'));
  const freshPause = choose('pause', 'daily');
  await surface.handleAction(freshPause);
  assert.equal(task.state, 'paused');
  assert(content().includes('已读回暂停状态'));
  await surface.handleAction(freshPause);
  assert.equal(requests.filter(call => call.options?.method === 'POST').length, 1, 'callback replay does not execute twice');
  await surface.handleAction(choose('resume', 'daily'));
  assert.equal(task.state, 'active');
  await surface.handleAction(choose('pause', 'daily'));
  assert.equal(task.state, 'paused', 'a legitimate new pause after resume is not confused with replay');
  failAfterWrite = true;
  const uncertainResume = choose('resume', 'daily');
  await surface.handleAction(uncertainResume);
  assert.equal(task.state, 'active');
  assert(content().includes('不能当作已生效'), 'uncertain acknowledgements are visible');
  surface.stop();
  surface = makeSurface();
  await surface.restore();
  await surface.handleAction(uncertainResume);
  assert.equal(requests.filter(call => call.options?.method === 'POST').length, 4, 'restart keeps idempotence receipts');
  await surface.command(summary, 'audit');
  assert(content().includes('allowed'));
  assert(content().includes('与其他项目共用'));
  assert(content().includes('未取得一致'));
  assert.equal(created, 1);

  runtime.projectSurface = surface;
  let submissions = 0;
  let submitted;
  let observed = 0;
  const helpers = { enrichSummaryWithChatMetadata: async (_runtime, value) => value,
    queueFeishuReply: async () => assert.fail('native queries must not duplicate the card as text'),
    observeRemoteLabMessage: async () => { observed++; return null; },
    addProcessingReaction: async () => null,
    submitRemoteLabRequest: async (_runtime, value) => { submissions++; submitted = value;
      return { sessionId: 'same-topic-session' }; } };
  await handleMessage(runtime, { ...summary, messageText: '/project memory' }, 'fixture', helpers);
  assert.equal(submissions, 0);
  assert.equal(observed, 0);
  await handleMessage(runtime, { ...summary, messageText: '/project memory 补充新事实' }, 'fixture', helpers);
  assert.equal(submissions, 1);
  assert.equal(submitted.threadId, 'topic');
  assert(submitted.messageText.includes('用户原文：\n补充新事实'));
  assert.equal(submitted.startThread, undefined, 'memory edits continue the original topic');

  // Exercise actual filesystem notifications, including atomic replacement.
  surface.stop();
  surface = makeSurface({ watchFiles: true });
  await surface.command(summary, 'memory');
  const updated = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('memory invalidation did not update the card')), 3000);
    onPatch = () => { if (content().includes('Live memory edit')) { clearTimeout(deadline); resolve(); } };
  });
  await writeFile(`${memoryPath}.next`, '## Project\n\nLive memory edit\n\n## Other\n\nExcluded');
  await rename(`${memoryPath}.next`, memoryPath);
  await updated;
  onPatch = null;
  await rm(memoryPath);
  await surface.refresh();
  assert(content().includes('记忆来源当前不可读'));
  assert(!content().includes('Live memory edit'), 'unavailable sources never silently use a stale snapshot');
  assert(patches > 0);
  console.log('PASS: Feishu project source binding, scoped reads, configuration controls, audit, replay/restart and live memory invalidation');
} finally {
  for (const surface of surfaces) surface.stop();
  await rm(home, { recursive: true, force: true });
}
