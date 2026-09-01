#!/usr/bin/env node

import assert from 'assert/strict';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const root = await mkdtemp(join(tmpdir(), 'remotelab-static-publish-'));
const publishRoot = join(root, 'instance-data', 'public-pages');
process.env.HOME = root;
process.env.REMOTELAB_PUBLIC_PAGES_DIR = publishRoot;
process.env.REMOTELAB_PUBLIC_PAGES_BASE_URL = 'https://pages.example.test/public-pages';

const {
  deleteStaticPublication,
  listStaticPublications,
  publishStaticSource,
  runStaticPublishCommand,
} = await import(`../lib/static-publish-command.mjs?test=${Date.now()}`);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

try {
  const source = join(root, 'site');
  await mkdir(join(source, 'assets'), { recursive: true });
  await writeFile(join(source, 'index.html'), '<!doctype html><title>First</title>\n', 'utf8');
  await writeFile(join(source, 'assets', 'site.css'), 'body { color: black; }\n', 'utf8');
  await writeFile(join(source, '.env'), 'SECRET=should-not-publish\n', 'utf8');

  const first = await publishStaticSource({
    source,
    slug: 'demo-page',
    verify: false,
  });
  assert.equal(first.slug, 'demo-page');
  assert.equal(first.publiclyReachable, true);
  assert.equal(first.url, 'https://pages.example.test/public-pages/demo-page/index.html');
  assert.equal(first.root, publishRoot);
  assert.equal(first.files, 2, 'hidden files should not count as publishable input');
  assert.equal(await exists(join(publishRoot, 'demo-page', 'index.html')), true);
  assert.equal(await exists(join(publishRoot, 'demo-page', 'assets', 'site.css')), true);
  assert.equal(await exists(join(publishRoot, 'demo-page', '.env')), false);
  assert.equal(
    JSON.parse(await readFile(join(publishRoot, 'demo-page', '_remote_publish.json'), 'utf8')).slug,
    'demo-page',
  );

  await assert.rejects(
    publishStaticSource({ source, slug: 'demo-page', verify: false }),
    /already exists/,
  );

  await writeFile(join(source, 'index.html'), '<!doctype html><title>Second</title>\n', 'utf8');
  const replaced = await publishStaticSource({
    source,
    slug: 'demo-page',
    replace: true,
    verify: false,
  });
  assert.equal(replaced.slug, 'demo-page');
  assert.match(await readFile(join(publishRoot, 'demo-page', 'index.html'), 'utf8'), /Second/);

  await assert.rejects(
    publishStaticSource({ source, slug: '../unsafe', verify: false }),
    /Invalid static publish slug/,
  );
  await assert.rejects(
    publishStaticSource({ source, slug: 'too-large', maxBytes: 1, verify: false }),
    /above the 1-byte limit/,
  );

  const publications = await listStaticPublications();
  assert.equal(publications.length, 1);
  assert.equal(publications[0].slug, 'demo-page');

  let output = '';
  const commandCode = await runStaticPublishCommand(['list', '--json'], {
    stdout: { write(value) { output += value; } },
    stderr: { write() {} },
  });
  assert.equal(commandCode, 0);
  assert.equal(JSON.parse(output).publications[0].slug, 'demo-page');

  const deleted = await deleteStaticPublication('demo-page');
  assert.equal(deleted.deleted, true);
  assert.equal(await exists(join(publishRoot, 'demo-page')), false);
  await assert.rejects(deleteStaticPublication('demo-page'), /does not exist/);

  console.log('test-static-publish-command: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
