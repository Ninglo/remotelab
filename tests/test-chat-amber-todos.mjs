import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'retired-personal-todo-'));
setIsolatedTestHome(home);
try {
  const file = join(home, 'legacy-todos.json');
  const original = JSON.stringify({ version: 1, people: { fixture: [{ title: 'retain history' }] } });
  await writeFile(file, original);
  for (const args of [['todo', '--help'], ['todo', 'list'], ['todo', 'add', '--title', 'must not persist']]) {
    await assert.rejects(promisify(execFile)(process.execPath, ['cli.js', ...args], {
      env: { ...process.env, REMOTELAB_DISPLAY_TODOS_FILE: file },
    }), error => error.code === 1 && /removed.*Feishu tasks/.test(error.stderr));
  }
  assert.equal(await readFile(file, 'utf8'), original);
  for (const file of ['templates/chat.html', 'static/chat.js', 'static/chat/amber-pet.css']) {
    assert.doesNotMatch(await readFile(new URL('../' + file, import.meta.url), 'utf8'), /amber-todos/);
  }
  console.log('Personal Todo retirement: old CLI cannot mutate history; frontend entry removed');
} finally { await rm(home, { recursive: true, force: true }); }
