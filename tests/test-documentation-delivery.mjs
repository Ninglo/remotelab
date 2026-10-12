import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { documentationImpact } from '../scripts/check-documentation-impact.mjs';
import { renderDocuments } from '../scripts/documentation-site.mjs';

const features = [{ sources: ['chat/example.mjs', 'docs/example.md'] }];
test('implementation changes need their own documentation or an explicit reviewed reason', () => {
  assert.equal(documentationImpact(['chat/example.mjs'], features).ok, false);
  assert.equal(documentationImpact(['chat/example.mjs', 'docs/unrelated.md'], features).ok, false);
  assert.equal(documentationImpact(['chat/example.mjs', 'docs/example.md'], features).ok, true);
  assert.equal(documentationImpact(['chat/example.mjs'], features, 'Docs-Impact: none — no change').ok, false);
  assert.equal(documentationImpact(['chat/example.mjs'], features, 'Docs-Impact: none — only repairs an internal cache; usage and conditions are unchanged').ok, true);
  assert.equal(documentationImpact(['tests/test-example.mjs', 'static/chat/example.css'], features).ok, true);
  assert.equal(documentationImpact(['display/server.mjs', 'display/USER_GUIDE.md'], features).ok, true);
  for (const file of ['automation/run.mjs', 'local-helper/server.mjs', 'scripts/setup.sh', 'setup.sh']) assert.equal(documentationImpact([file], features).ok, false);
});

test('the website derives current Markdown, preserves source links and changes its input hash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'documentation-test-'));
  try {
    for (const dir of ['docs/architecture-atlas', 'static', 'display']) await mkdir(path.join(root, dir), { recursive: true });
    await cp(new URL('../static/marked.min.js', import.meta.url), path.join(root, 'static/marked.min.js'));
    const docs = [{ source: 'display/USER_GUIDE.md', route: 'manual-display.html', title: '副屏', description: '用法' }, { source: 'display/README.md', route: 'maintenance.html', title: '维护' }];
    await writeFile(path.join(root, 'docs/architecture-atlas/project.json'), JSON.stringify({ documentation: docs }));
    await writeFile(path.join(root, 'display/example.png'), 'fixture image');
    await writeFile(path.join(root, 'display/USER_GUIDE.md'), '# 使用\n\n先预览再应用。\n\n[维护](README.md#recovery)\n\n![预览](example.png)');
    await writeFile(path.join(root, 'display/README.md'), '# Recovery\n\n保留配对。');
    const before = await renderDocuments(root, 'a'.repeat(40));
    const html = await readFile(path.join(root, 'docs/architecture-atlas/manual-display.html'), 'utf8');
    assert.match(html, /先预览再应用/); assert.match(html, /maintenance.html#recovery/);
    assert.match(html, /src="manual-assets\/display\/example.png"/);
    assert.equal(await readFile(path.join(root, 'docs/architecture-atlas/manual-assets/display/example.png'), 'utf8'), 'fixture image');
    assert.ok(before['display/example.png']);
    assert.equal(await readFile(path.join(root, 'docs/architecture-atlas/reference-manual-display.md'), 'utf8'), await readFile(path.join(root, 'display/USER_GUIDE.md'), 'utf8'));
    await writeFile(path.join(root, 'display/USER_GUIDE.md'), '# 使用\n\n新版操作。');
    const after = await renderDocuments(root, 'b'.repeat(40));
    assert.notEqual(before['display/USER_GUIDE.md'], after['display/USER_GUIDE.md']);
    const updated = await readFile(path.join(root, 'docs/architecture-atlas/manual-display.html'), 'utf8');
    assert.match(updated, /新版操作/); assert.doesNotMatch(updated, /先预览再应用/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
