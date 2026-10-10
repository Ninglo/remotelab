import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
if (!args.includes('--extension') || !args.includes('--expected')) throw Error('Use --extension <source directory> --expected <fresh SHA-256 manifest JSON>');
const root = resolve(fileURLToPath(new URL('..', import.meta.url))), target = resolve(option('--extension'));
const expected = JSON.parse(await readFile(option('--expected'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = ['build.mjs', 'manifest.json', 'message-background.js', 'content.js'];
for (const name of inputs) if (!/^[a-f0-9]{64}$/.test(expected[name]) || hash(await readFile(join(target, name))) !== expected[name]) throw Error('Concurrent or unknown source: ' + name);
const background = await readFile(join(target, 'message-background.js'), 'utf8'), build = await readFile(join(target, 'build.mjs'), 'utf8');
const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
if (!manifest.host_permissions.includes('https://index.jiujianian.dev/*')) manifest.host_permissions.push('https://index.jiujianian.dev/*');
manifest.version = '1.1.0';
const nextBuild = build.includes("'personal-workspace.js'") ? build : build.replace("'resource-nav.js'", "'resource-nav.js','personal-workspace.js'");
if (!nextBuild.includes("'personal-workspace.js'")) throw Error('Unknown extension build contract');
const files = {
  'personal-workspace.js': await readFile(join(root, 'static/feishu-personal-workspace.js'), 'utf8'),
  'personal-workspace-background.js': await readFile(join(root, 'static/feishu-personal-workspace-background.js'), 'utf8'),
  'message-background.js': background.includes("importScripts('personal-workspace-background.js')") ? background : background + "\nimportScripts('personal-workspace-background.js');\n",
  'build.mjs': nextBuild, 'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
};
const backup = join(target, '..', 'personal-workspace-backup-' + Date.now()); await mkdir(backup);
for (const name of inputs) await writeFile(join(backup, name), await readFile(join(target, name)), { mode: 0o600 });
for (const name of inputs) if (hash(await readFile(join(target, name))) !== expected[name]) throw Error('Concurrent source change; no replacement: ' + name);
for (const [name, content] of Object.entries(files)) { await writeFile(join(target, name + '.next'), content); await rename(join(target, name + '.next'), join(target, name)); }
await promisify(execFile)(process.execPath, [join(target, 'build.mjs')], { cwd: target });
console.log(JSON.stringify({ backup, version: manifest.version, files: Object.fromEntries(await Promise.all([...Object.keys(files), 'content.js'].map(async name => [name, hash(await readFile(join(target, name)))]))) }));
