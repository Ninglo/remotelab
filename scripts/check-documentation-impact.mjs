import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
export function documentationImpact(files, features, message = '') {
  const changed = new Set(files);
  const implementation = files.filter(file => /^(chat|lib|static|templates|display|connectors|knowledge|automation|local-helper|scripts|cloudflare)\/.*\.(?:m?js|html|py|swift|sh)$/.test(file) || /^[^/]+\.(?:m?js|sh)$/.test(file));
  const exemption = /^Docs-Impact:\s*none\s*(?:—|--|:)\s*(.{12,})$/mi.exec(message);
  const updates = [], missing = [];
  for (const file of implementation) {
    const related = features.filter(feature => feature.sources.includes(file));
    const docs = new Set(related.flatMap(feature => feature.sources.filter(source => source.endsWith('.md'))));
    if (/^scripts\/(?:check-documentation-impact|documentation-site)\.mjs$/.test(file)) docs.add('docs/documentation-delivery.md');
    if (file.startsWith('display/') || /display-settings/.test(file)) {
      docs.add('display/USER_GUIDE.md'); docs.add('display/README.md');
    }
    if (file.includes('recording')) docs.add('docs/platform-skills/hardware-recording.md');
    if (!docs.size) { docs.add('README.md'); docs.add('README.zh.md'); docs.add('docs/README.md'); }
    docs.add('docs/architecture-atlas/features.json');
    const touched = [...docs].filter(doc => changed.has(doc));
    if (touched.length) updates.push({ file, documents: touched });
    else if (!exemption) missing.push({ file, suggestedDocuments: [...docs] });
  }
  return { ok: missing.length === 0, updates, missing, noImpactReason: exemption?.[1] || null,
    boundary: 'Checks associated document changes or an explicit review reason, not semantic accuracy or deployment.' };
}

export async function check({ cwd = process.cwd(), staged = false, base = 'HEAD^', head = 'HEAD', messageFile } = {}) {
  const git = async args => (await exec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACDMRT', '-z'] : ['diff', '--name-only', '--diff-filter=ACDMRT', '-z', base, head];
  const files = (await git(args)).split('\0').filter(Boolean);
  let message = messageFile ? await readFile(messageFile, 'utf8') : '';
  if (!staged && !messageFile) {
    // Do not let one commit's no-impact statement exempt unrelated earlier changes.
    const messages = (await git(['log', '--no-merges', '--format=%B%x00', `${base}..${head}`])).split('\0').map(text => text.trim()).filter(Boolean);
    if (messages.length && messages.every(text => /^Docs-Impact:\s*none\s*(?:—|--|:)\s*(.{12,})$/mi.test(text))) message = messages.join('\n');
  }
  const raw = staged ? await git(['show', ':docs/architecture-atlas/features.json']) : await git(['show', `${head}:docs/architecture-atlas/features.json`]);
  return documentationImpact(files, JSON.parse(raw).groups.flatMap(group => group.features), message);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), option = flag => args[args.indexOf(flag) + 1];
  try {
    const result = await check({ staged: args.includes('--staged'), base: args.includes('--base') ? option('--base') : 'HEAD^', head: args.includes('--head') ? option('--head') : 'HEAD', messageFile: args.includes('--message-file') ? option('--message-file') : undefined });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) { console.error('Update an associated document, or record Docs-Impact: none — a specific review reason in the commit message.'); process.exitCode = 1; }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
