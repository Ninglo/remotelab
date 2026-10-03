import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderGuideShell } from './guide-shell-template.js';

const atlas = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(atlas, '../..');
const catalog = JSON.parse(await readFile(path.join(atlas, 'project.json'), 'utf8'));
const argument = process.argv[2];
if (!argument) throw new Error('Usage: node docs/architecture-atlas/assemble-site.mjs <empty-output-directory>');
const destination = path.resolve(argument);
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
const allowed = new Set(['.html', '.css', '.js', '.md', '.json', '.svg', '.png', '.webp', '.jpg', '.jpeg', '.gif', '.woff', '.woff2']);

for (const chapter of catalog.chapters) {
  const source = path.resolve(root, chapter.source);
  if (!inside(root, source)) throw new Error(`Chapter source leaves the repository: ${chapter.id}`);
  if (inside(source, destination) || inside(destination, source)) throw new Error('Output must be separate from the source directories');
}
await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length) throw new Error('Output must be empty; use a new directory to avoid stale assets');

const files = [];
async function copyTree(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile() && allowed.has(path.extname(entry.name))) {
      await cp(from, to);
      if (entry.name === 'memory-reader.js' && source === path.join(atlas, 'output')) {
        const script = await readFile(to, 'utf8');
        await writeFile(to, script.replaceAll('../../memory-architecture/', '../memory/'));
      }
      if (entry.name === 'index.html' && source === path.join(atlas, 'output')) {
        const html = await readFile(to, 'utf8');
        await writeFile(to, html.replace('href="../../memory-architecture/index.html" data-memory-chapter', 'href="../memory/index.html" data-memory-chapter'));
      }
      if (entry.name === 'index.html' && source === path.join(root, 'docs/memory-architecture')) {
        const html = await readFile(to, 'utf8');
        await writeFile(to, html.replace('href="../architecture-atlas/project.html" data-project-home', 'href="../project.html" data-project-home'));
      }
      if (entry.name === 'README.md' && source === path.join(root, 'docs/memory-architecture')) {
        const markdown = await readFile(to, 'utf8');
        await writeFile(to, markdown.replaceAll('../architecture-atlas/README.md', '../README.md'));
      }
      files.push(path.relative(destination, to).split(path.sep).join('/'));
    }
  }
}
await copyTree(atlas, destination);
// Chapters already inside the atlas are copied once. External chapters retain
// their existing authoritative sources and join the same publication here.
for (const chapter of catalog.chapters) {
  const source = path.resolve(root, chapter.source);
  if (inside(atlas, source)) continue;
  const directory = path.posix.dirname(chapter.route);
  if (directory === '.' || directory.startsWith('../') || path.posix.isAbsolute(directory)) {
    throw new Error(`External chapter needs a relative subdirectory: ${chapter.id}`);
  }
  const target = path.resolve(destination, directory);
  if (!inside(destination, target)) throw new Error(`Invalid chapter route: ${chapter.id}`);
  await copyTree(source, target);
}
for (const route of [catalog.entry, ...catalog.chapters.map(chapter => chapter.route)]) {
  if (!files.includes(route)) throw new Error(`Missing project entry: ${route}`);
}
// Static navigation remains usable without JavaScript. Chapter facts and
// interactive diagrams keep their existing authoritative content sources.
for (const page of catalog.pages || []) {
  if (!files.includes(page.route)) throw new Error(`Missing guide page: ${page.route}`);
  const target = path.join(destination, page.route);
  const prefix = '../'.repeat(page.route.split('/').length - 1) || './';
  let html = await readFile(target, 'utf8');
  html = html.replaceAll('../architecture-atlas/guide.css', '../guide.css')
    .replaceAll('../architecture-atlas/guide-shell.js', '../guide-shell.js');
  html = html.replace(/<body([^>]*)>/, (_, attributes) => `<body${attributes}>\n${renderGuideShell(catalog, page, prefix)}`);
  html = html.replace(/(<main[^>]*>)/, '$1<span id="guide-main" tabindex="-1"></span>');
  await writeFile(target, html);
}
files.sort();
await writeFile(path.join(destination, 'site-files.json'), `${JSON.stringify({ projectId: catalog.id, entry: catalog.entry, chapters: catalog.chapters.map(({ id, route }) => ({ id, route })), files }, null, 2)}\n`);
console.log(JSON.stringify({ projectId: catalog.id, destination, entry: catalog.entry, files: files.length + 1, chapters: catalog.chapters.length }));
