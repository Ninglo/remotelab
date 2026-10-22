// Opt-in real Harness execution; isolated task files, no production settings or Feishu writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

if (process.env.REMOTELAB_LIVE_SELF_REVIEW !== '1') {
  console.log('SKIP: REMOTELAB_LIVE_SELF_REVIEW=1 spends real model budget on isolated file tasks.');
  process.exit(0);
}
const originalProviderHome = process.env.CODEX_HOME || join(process.env.HOME, '.codex');
const providerHome = await mkdtemp(join(tmpdir(), 'self-review-provider-'));
// Reuse only this runner's configured authentication in a disposable provider
// home. No native history, cache or configuration writes reach the live home.
for (const name of ['config.toml', 'auth.json']) {
  try { await copyFile(join(originalProviderHome, name), join(providerHome, name)); await chmod(join(providerHome, name), 0o600); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const providerEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('REMOTELAB_')));
providerEnv.CODEX_HOME = providerHome;
providerEnv.HOME = providerHome;
const outputRoot = process.env.REMOTELAB_SELF_REVIEW_EVIDENCE || await mkdtemp(join(tmpdir(), 'delivery-self-review-live-'));
await mkdir(outputRoot, { recursive: true });
const stateHome = join(outputRoot, 'state'); await mkdir(stateHome, { recursive: true });
setIsolatedTestHome(stateHome);
const { updateAuthDocument } = await import('../lib/auth-config.mjs');
const { changePersonMessageReplies } = await import('../chat/person-message-replies.mjs');
const { resolveMessageReplyPolicy } = await import('../chat/message-reply-settings.mjs');
const { deliverySelfReviewPrompt } = await import('../chat/delivery-self-review.mjs');
const { collectGeneratedResultFilesFromRun } = await import('../chat/session-result-files.mjs');
const { publishLocalFileAssetFromPath, localizeFileAsset } = await import('../chat/file-assets.mjs');
const { buildSessionDisplayEvents } = await import('../chat/session-display-events.mjs');
const { buildReplyPublicationPayload } = await import('../chat/reply-publication.mjs');
await updateAuthDocument(d => { d.people = [{ id: 'person_test', name: 'Isolated test', identities: [{ id: 'web_test', kind: 'web', subjectId: 'test' }] }]; d.primaryPersonId = 'person_test'; });
const actor = { personId: 'person_test', identityId: 'web_test' };
await changePersonMessageReplies({ action: 'self-review', enabled: true, expectedRevision: 0, confirm: true }, actor);
const policy = await resolveMessageReplyPolicy({ usageSurface: 'web', viewPersonId: actor.personId, initiatedByIdentityId: actor.identityId });
const rules = deliverySelfReviewPrompt(policy, actor);
const bytes = '{"rows":2,"total_units":30}\n';
// A genuine HTTP-delivered file, while connector receipts remain an explicitly
// local fixture. This test never claims to have sent a real Feishu message.
const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(bytes); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/report.json`;
assert.equal(await (await fetch(url)).text(), bytes);
const cases = [
  { id: 'repair-off', enabled: false, kind: 'repair' },
  { id: 'repair-on', enabled: true, kind: 'repair' },
  { id: 'delivered-on', enabled: true, kind: 'delivered' },
  { id: 'blocked-on', enabled: true, kind: 'blocked' },
  { id: 'steer-on', enabled: true, kind: 'steer' },
];
const results = [];
try {
  for (const test of cases) {
    const folder = join(outputRoot, test.id); await mkdir(folder);
    const report = join(folder, 'report.json'), empty = join(folder, 'summary.txt');
    if (['repair', 'steer'].includes(test.kind)) {
      await writeFile(join(folder, 'source.csv'), 'order,units\na,10\nb,20\n');
      await writeFile(report, '{"rows":999,"total_units":999,"source":"mock"}\n');
      await writeFile(empty, '');
    }
    if (test.kind === 'delivered') await writeFile(report, bytes);
    if (test.kind === 'blocked') await writeFile(join(folder, 'draft.txt'), '旧答复：已完成全部真实数据统计，总计999。');
    let deliveredEvents;
    if (test.kind === 'delivered') {
      const asset = await publishLocalFileAssetFromPath({ sessionId: 'fixture-delivered', localPath: report });
      deliveredEvents = buildSessionDisplayEvents([
        { type: 'message', role: 'user', seq: 1, content: '给我统计文件' },
        { type: 'message', role: 'assistant', seq: 2, source: 'result_file_assets', resultRunId: 'previous-run', content: '',
          attachments: [{ assetId: asset.id, originalName: 'report.json', sizeBytes: asset.sizeBytes, downloadUrl: url, renderAs: 'file' }] },
      ], { sessionRunning: false });
    }
    const task = ['repair', 'steer'].includes(test.kind)
      ? '原交办：读取source.csv真实订单，交付report.json（字段rows和total_units），以及summary.txt中文结果说明。验收：两份内容准确、非空、与原始数据一致，最后附文件。前一阶段说“已经完成”，留下了这两个文件。请接着完成这次交付。'
        + (test.kind === 'steer' ? '\n中途补充：先回答8乘9，再继续原统计任务；统计范围改为只计订单a。' : '')
      : test.kind === 'blocked'
        ? '原交办：统计真实订单CSV，输出统计文件。原始CSV尚未提供，也不能用示例数替代，不允许查外部服务。目录里有旧答复draft.txt，请接续这项交办并给我当前结果。'
        : '原交办：生成rows=2、total_units=30的JSON统计文件并交付。文件在本目录report.json。原可见会话只有以下附件，没有文字答复：\n'
          + JSON.stringify(deliveredEvents) + '\n本地测试投递回执：confirmed，用户可下载地址：' + url + '。请完成这一轮的最终回复。';
    const prompt = `这是隔离的产品验收任务，你是执行这个任务的Harness。仅在当前目录读写任务文件，不修改产品配置、不联系任何人、不创建子Agent；可读取本地文件。不需要介绍测试。
文件交付格式：仅在用户要求或需要附件作为可用成果时，用 Artifacts: 块，每个列表项填写一个绝对文件路径。系统会将这些文件作为附件交付，普通路径提及不发布文件。没有外发服务授权。
${test.enabled ? rules : deliverySelfReviewPrompt(null)}\n\n用户交办：\n${task}`;
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'project_doc_max_bytes=0', '-o', join(folder, 'final.txt'), '-'];
    const started = Date.now();
    const run = await new Promise(resolve => {
      const child = spawn('codex', args, { cwd: folder, env: providerEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
      child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr, error: error.message }); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.stdin.end(prompt);
    });
    const durationMs = Date.now() - started;
    await writeFile(join(folder, 'execution.json'), JSON.stringify({ args, prompt, durationMs, ...run }, null, 2));
    const events = run.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const final = await readFile(join(folder, 'final.txt'), 'utf8').catch(() => '');
    let error = '';
    const published = [];
    try {
      assert.equal(run.code, 0, run.stderr.slice(-1000));
      if (['repair', 'steer'].includes(test.kind)) {
        const data = JSON.parse(await readFile(report, 'utf8'));
        assert.equal(data.rows, test.kind === 'steer' ? 1 : 2);
        assert.equal(data.total_units, test.kind === 'steer' ? 10 : 30);
        assert((await readFile(empty, 'utf8')).trim().length > 0);
        const collected = await collectGeneratedResultFilesFromRun({}, { folder }, [{ type: 'message', role: 'assistant', content: final }]);
        assert(collected.some(f => f.localPath === report)); assert(collected.some(f => f.localPath === empty));
        for (const file of collected) {
          const asset = await publishLocalFileAssetFromPath({ sessionId: test.id, localPath: file.localPath });
          assert.equal(await readFile(await localizeFileAsset(asset.id), 'utf8'), await readFile(file.localPath, 'utf8'));
          published.push({ assetId: asset.id, originalName: asset.originalName, sizeBytes: asset.sizeBytes });
        }
        const payload = buildReplyPublicationPayload([{ type: 'message', role: 'assistant', seq: 1, runId: test.id, content: final },
          { type: 'message', role: 'assistant', seq: 2, source: 'result_file_assets', resultRunId: test.id, attachments: published }], { id: test.id }, { includeSessionEntry: false });
        assert.equal(payload.attachments.length, 2);
        if (test.kind === 'steer') assert.match(events.filter(e => e.item?.type === 'agent_message').map(e => e.item.text).join('\n'), /72|七十二/);
      } else if (test.kind === 'delivered') {
        assert.equal(await readFile(report, 'utf8'), bytes);
        assert.doesNotMatch(final, /Artifacts:/, 'do not resend an already delivered correct file');
        assert.doesNotMatch(final, /未交付|尚未交付|未完成|没.*附件|无法.*下载/);
      } else {
        assert.match(final, /缺|未提供|没有.*(数据|CSV)|尚未/);
        assert.doesNotMatch(final, /Artifacts:/);
      }
    } catch (e) { error = e.message; }
    const usage = events.findLast(e => e.type === 'turn.completed')?.usage;
    const item = { id: test.id, passed: !error, error, durationMs, promptChars: prompt.length, usage,
      commandCount: events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').length, published, final };
    results.push(item); console.log(JSON.stringify(item));
    await writeFile(join(outputRoot, 'results.json'), JSON.stringify({ procedureChars: rules.length, results }, null, 2));
  }
} finally { server.close(); await rm(providerHome, { recursive: true, force: true }); }
console.log(`Evidence: ${outputRoot}`);
assert(results.every(r => r.passed), 'Inspect execution evidence for failures; do not infer general reliability from this small sample.');
