import { readFile, writeFile, rename, open, unlink, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reconcileReadingGroups } from '../lib/project-reading.mjs';
import { validateProjectMemoryRuntime } from '../chat/project-memory-runtime.mjs';

const exec = promisify(execFile);
export async function lark(args, profile) {
  const { stdout } = await exec('lark-cli', ['--profile', profile, ...args, '--as', 'bot', '--format', 'json'],
    { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  const result = JSON.parse(stdout);
  if (!result.ok) throw new Error(JSON.stringify(result.error || result));
  return result.data;
}
export async function discoverGroups({ runtimePath, profile, route, tenant, output, request = lark }) {
  const chats = [], tokens = new Set(); let token = '';
  for (let page = 0; ; page++) {
    if (page >= 100) throw new Error('Group inventory pagination exceeded safety bound');
    const data = await request(['im', '+chat-list', '--page-size', '100', ...(token ? ['--page-token', token] : [])], profile);
    if (!Array.isArray(data.chats)) throw new Error('Missing chat inventory');
    chats.push(...data.chats);
    if (!data.has_more) break;
    if (!data.page_token || tokens.has(data.page_token)) throw new Error('Incomplete group inventory pagination');
    token = data.page_token; tokens.add(token);
  }
  // A failed inventory never removes an existing group or changes its level.
  const lock = await open(runtimePath + '.reading-lock', 'wx', 0o600);
  try {
    const before = await readFile(runtimePath, 'utf8');
    const { config, changes } = reconcileReadingGroups(JSON.parse(before), chats, route, tenant);
    validateProjectMemoryRuntime(config);
    const after = JSON.stringify(config, null, 2) + '\n';
    if (await readFile(runtimePath, 'utf8') !== before) throw new Error('Runtime changed concurrently');
    if (after !== before) {
      const temporary = runtimePath + '.reading-' + process.pid;
      await writeFile(temporary, after, { mode: 0o600 }); await rename(temporary, runtimePath);
    }
    const result = { checkedAt: new Date().toISOString(), route, complete: true, total: chats.length, changes, chats };
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 });
    return { total: chats.length, addedOrExcluded: changes.length };
  } finally { await lock.close(); await unlink(runtimePath + '.reading-lock'); }
}
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a, []));
  for (const k of ['runtime', 'profile', 'route', 'tenant', 'output']) if (!args[k]) throw new Error(`--${k} required`);
  console.log(JSON.stringify(await discoverGroups({ runtimePath: args.runtime, ...args })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
