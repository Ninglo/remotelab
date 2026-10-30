import { readFile, writeFile, mkdir, mkdtemp, cp, readdir, rm, rename, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const exec = promisify(execFile), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = body => createHash('sha256').update(body).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const git = async (...args) => (await exec('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
async function filesIn(dir, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Unexpected symlink: ${name}`);
    if (entry.isDirectory()) result.push(...await filesIn(dir, name));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}

export async function renderDocuments(source, revision) {
  const atlas = path.join(source, 'docs/architecture-atlas');
  const catalog = JSON.parse(await readFile(path.join(atlas, 'project.json'), 'utf8'));
  const context = vm.createContext({});
  vm.runInContext(await readFile(path.join(source, 'static/marked.min.js'), 'utf8'), context);
  const documents = catalog.documentation;
  const links = new Map(documents.map(doc => [doc.source, doc.route]));
  const sectionId = text => text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
  const inputs = {};
  for (const doc of documents) {
    if (path.isAbsolute(doc.source) || doc.source.split('/').includes('..') || !/^[a-z0-9-]+\.html$/.test(doc.route)) throw Error('Invalid documentation route');
    const text = await readFile(path.join(source, doc.source), 'utf8'); inputs[doc.source] = sha(text);
    const renderer = new context.marked.Renderer(), images = new Map();
    renderer.image = function(token) {
      let href = token.href;
      if (!/^(?:[a-z]+:|\/)/i.test(href)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(doc.source), href));
        if (target.startsWith('../') || !/\.(png|jpe?g|gif|webp|svg)$/i.test(target)) throw Error(`Invalid document image: ${href}`);
        href = `manual-assets/${target}`;
        images.set(target, href);
      }
      if (/^(?:javascript|data):/i.test(href)) throw Error('Unsafe document image');
      return `<img src="${escape(href)}" alt="${escape(token.text)}"${token.title ? ` title="${escape(token.title)}"` : ''}>`;
    };
    renderer.heading = function(token) { return `<h${token.depth} id="${escape(sectionId(token.text))}">${this.parser.parseInline(token.tokens)}</h${token.depth}>`; };
    renderer.link = function(token) {
      let href = token.href;
      if (!/^(?:[a-z]+:|\/|#)/i.test(href)) {
        const [relative, anchor] = href.split('#');
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(doc.source), relative));
        href = links.has(target) ? `${links.get(target)}${anchor ? '#' + anchor : ''}` : `https://github.com/Ninglo/remotelab/blob/${revision}/${target}${anchor ? '#' + anchor : ''}`;
      }
      if (/^(?:javascript|data):/i.test(href)) throw Error('Unsafe document link');
      return `<a href="${escape(href)}">${this.parser.parseInline(token.tokens)}</a>`;
    };
    const body = context.marked.parse(text, { renderer });
    for (const [input, output] of images) {
      const bytes = await readFile(path.join(source, input)); inputs[input] = sha(bytes);
      await mkdir(path.dirname(path.join(atlas, output)), { recursive: true });
      await writeFile(path.join(atlas, output), bytes);
    }
    const reference = `reference-${doc.route.replace('.html', '.md')}`;
    await writeFile(path.join(atlas, reference), text);
    await writeFile(path.join(atlas, doc.route), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(doc.title)} · RemoteLab</title><link rel="stylesheet" href="guide.css"><script type="module" src="guide-shell.js"></script><style>.manual{max-width:900px;padding:28px} .manual pre,.manual table{display:block;overflow:auto} .manual td,.manual th{padding:10px;border-bottom:1px solid #ddd}.manual img{max-width:100%}.manual p,.manual li{overflow-wrap:anywhere}</style></head><body data-guide-page="${doc.route}" data-guide-chapter="manuals"><main class="manual"><p><a href="manuals.html">使用与维护文档</a> · <a href="project.html">整体说明</a></p><p>来自 <a href="https://github.com/Ninglo/remotelab/blob/${revision}/${escape(doc.source)}">${escape(doc.source)}</a> · 源码 ${revision.slice(0, 8)} · <a href="${reference}">下载原文</a></p><p>此版本标记说明来源；实例运行、配置与历史案例沿各自证据核对。</p>${body}</main></body></html>`);
  }
  await writeFile(path.join(atlas, 'manuals.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>使用与维护文档</title><link rel="stylesheet" href="guide.css"><script type="module" src="guide-shell.js"></script></head><body data-guide-page="manuals.html" data-guide-chapter="manuals"><main style="max-width:900px;padding:28px"><h1>使用与维护文档</h1><p>以下页面由仓库原文生成。功能如何使用、如何维护与实际部署分别核对；修改正文会在下一次成功出版后出现在同一入口。</p><ul>${documents.map(doc => `<li><a href="${doc.route}">${escape(doc.title)}</a> — ${escape(doc.description)}</li>`).join('')}</ul><p><a href="project.html">返回消息全程</a> · <a href="documentation-manifest.json">本次文档来源与哈希</a></p></main></body></html>`);
  return inputs;
}

async function snapshot(committed) {
  const temp = await mkdtemp(path.join(tmpdir(), 'remotelab-docs-'));
  const source = path.join(temp, 'source'); await mkdir(source);
  if (committed) {
    const archive = path.join(temp, 'source.tar'); await git('archive', '--format=tar', `--output=${archive}`, 'HEAD');
    await exec('tar', ['-xf', archive, '-C', source]); await rm(archive);
  } else {
    const files = (await git('ls-files', '--cached', '--others', '--exclude-standard')).split('\n').filter(Boolean);
    for (const name of files) {
      try { await mkdir(path.dirname(path.join(source, name)), { recursive: true }); await cp(path.join(root, name), path.join(source, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return { temp, source };
}

async function build(source, out, revision) {
  const atlas = path.join(source, 'docs/architecture-atlas');
  const inputs = await renderDocuments(source, revision);
  for (const script of ['render-features.mjs', 'render-deliverables.mjs']) await exec(process.execPath, [path.join(atlas, script)], { cwd: source });
  await exec(process.execPath, [path.join(atlas, 'assemble-site.mjs'), out], { cwd: source });
  const manifest = { schema: 1, sourceRevision: revision, generatedAt: new Date().toISOString(), inputs, meaning: 'Document source version; not proof of service deployment or business acceptance.' };
  // Version local assets from their bytes, including ES module imports, so a
  // same-slug publication cannot mix a new page with a cached old module.
  const all = await filesIn(out), hashes = {};
  for (const name of all) hashes[name] = sha(await readFile(path.join(out, name)));
  for (const name of all.filter(name => /\.(html|js|css)$/.test(name))) {
    let body = await readFile(path.join(out, name), 'utf8');
    body = body.replace(/(["'])(\.?\.?\/[^"'\s]+|[a-zA-Z0-9_-][^"'\s]*\.(?:js|css)(?:\?[^"'\s]*)?)\1/g, (match, quote, url) => {
      const [base] = url.split(/[?#]/), target = path.posix.normalize(path.posix.join(path.posix.dirname(name), base));
      return hashes[target] && /\.(js|css)$/.test(base) ? `${quote}${base}?v=${hashes[target].slice(0, 12)}${quote}` : match;
    });
    await writeFile(path.join(out, name), body);
  }
  await writeFile(path.join(out, 'documentation-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const name of await filesIn(out)) {
    if (!/\.(?:html|js|css|json|md|txt|svg)$/.test(name)) continue;
    const text = await readFile(path.join(out, name), 'utf8');
    if (/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|\b(?:oc_|om_x|person_|identity_)[a-f0-9]{16,}|\bsk-[a-zA-Z0-9]{24,}/.test(text)) throw Error(`Private material in publication: ${name}`);
  }
  return manifest;
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function install() {
  const custom = await git('config', '--get', 'core.hooksPath').catch(() => '');
  if (custom) throw Error(`Existing core.hooksPath ${custom}; integrate hooks explicitly without overwriting it.`);
  const dir = path.resolve(root, await git('rev-parse', '--git-dir'));
  const hookDir = path.join(dir, 'hooks'); await mkdir(hookDir, { recursive: true });
  const hooks = {
    'commit-msg': `exec ${quote(process.execPath)} scripts/check-documentation-impact.mjs --staged --message-file "$1"`,
    'post-commit': `${quote(process.execPath)} scripts/documentation-site.mjs publish || echo 'Documentation publication failed; original site retained. See .git/remotelab-documentation-result.json.' >&2`,
    'post-merge': `${quote(process.execPath)} scripts/documentation-site.mjs publish || echo 'Documentation publication failed; original site retained. See .git/remotelab-documentation-result.json.' >&2`,
  };
  for (const name of Object.keys(hooks)) {
    const existing = await readFile(path.join(hookDir, name), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (existing && !existing.includes('# remotelab-documentation-hook')) throw Error(`Existing ${name} hook; not overwritten.`);
  }
  const { PUBLIC_PAGES_DIR, PUBLIC_PAGES_BASE_URL } = await import('../lib/config.mjs');
  await writeFile(path.join(dir, 'remotelab-documentation.json'), JSON.stringify({ enabled: true, publicPagesDir: PUBLIC_PAGES_DIR, publicBase: PUBLIC_PAGES_BASE_URL, backupDir: path.join(path.dirname(PUBLIC_PAGES_DIR), 'documentation-backups') }, null, 2), { mode: 0o600 });
  for (const [name, command] of Object.entries(hooks)) {
    await writeFile(path.join(hookDir, name), `#!/bin/sh\n# remotelab-documentation-hook\ncd "$(git rev-parse --show-toplevel)" || exit 1\n${command}\n`); await chmod(path.join(hookDir, name), 0o700);
  }
  console.log('Installed document review and publication hooks for this checkout and its configured instance.');
}

async function publish() {
  const dir = path.resolve(root, await git('rev-parse', '--git-dir'));
  const config = JSON.parse(await readFile(path.join(dir, 'remotelab-documentation.json'), 'utf8'));
  if (!config.enabled) return;
  const resultPath = path.join(dir, 'remotelab-documentation-result.json'), lock = path.join(dir, 'remotelab-documentation.lock');
  // Atomic directory lock; another publication must not replace a newer one.
  await mkdir(lock).catch(error => { throw Error(`Documentation publisher is already running or needs stale-lock inspection (${error.code}).`); });
  let temp;
  try {
    const revision = await git('rev-parse', 'HEAD');
    const tree = await git('ls-tree', '-r', 'HEAD', '--', 'docs', 'README.md', 'README.zh.md', 'display/README.md', 'display/USER_GUIDE.md', 'scripts/documentation-site.mjs', 'static/marked.min.js', 'feature_list.json', 'progress.txt', 'CHANGELOG.md');
    const inputHash = sha(tree), previous = await readFile(resultPath, 'utf8').then(JSON.parse).catch(() => null);
    if (previous?.status === 'published' && previous.inputHash === inputHash) { console.log('Documentation inputs unchanged; publication retained.'); return; }
    const snap = await snapshot(true); temp = snap.temp;
    const out = path.join(temp, 'site'); await build(snap.source, out, revision);
    if (revision !== await git('rev-parse', 'HEAD')) throw Error('Source advanced during build; rerun publication for the new HEAD.');
    const files = await filesIn(out), sums = {};
    for (const name of files) sums[name] = sha(await readFile(path.join(out, name)));
    const backup = path.join(config.backupDir, revision); await mkdir(backup, { recursive: true });
    await cp(out, path.join(backup, 'site'), { recursive: true });
    // Only the documentation project and its exact input files enter the backup.
    const catalog = JSON.parse(await readFile(path.join(snap.source, 'docs/architecture-atlas/project.json'), 'utf8'));
    for (const name of ['docs/architecture-atlas', 'docs/memory-architecture', ...catalog.documentation.map(doc => doc.source), 'scripts/documentation-site.mjs', 'static/marked.min.js']) {
      await mkdir(path.dirname(path.join(backup, 'source', name)), { recursive: true });
      await cp(path.join(snap.source, name), path.join(backup, 'source', name), { recursive: true });
    }
    await writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ revision, inputHash, files: sums }, null, 2));
    await writeFile(path.join(backup, 'SHA256SUMS'), Object.entries(sums).map(([file, hash]) => `${hash}  site/${file}`).join('\n') + '\n');
    await writeFile(path.join(backup, 'RESTORE.md'), '# Restore\n\nRun `sha256sum -c SHA256SUMS` in this directory. The site directory is the complete assembled publication. Publish site to the original remotelab-architecture-atlas slug with the instance publisher; verify its manifest and pages. Source files preserve the original document inputs and their generated pages.\n');
    const target = path.join(config.publicPagesDir, 'remotelab-architecture-atlas'), recovery = path.join(temp, 'previous-site');
    const hadPrevious = await cp(target, recovery, { recursive: true }).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
    try {
      await exec(process.execPath, [path.join(root, 'cli.js'), 'publish', 'static', '--access', 'public', '--source', out, '--slug', 'remotelab-architecture-atlas', '--replace', '--json', '--no-verify'], { cwd: root, env: { ...process.env, REMOTELAB_PUBLIC_PAGES_DIR: config.publicPagesDir, REMOTELAB_PUBLIC_PAGES_BASE_URL: config.publicBase || '' }, maxBuffer: 1024 * 1024 });
      for (const [name, hash] of Object.entries(sums)) if (sha(await readFile(path.join(target, name))) !== hash) throw Error(`Published file readback differs: ${name}`);
    } catch (error) {
      if (hadPrevious) {
        const failed = `${target}.documentation-failed-${Date.now()}`;
        await rename(target, failed).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await cp(recovery, target, { recursive: true }); await rm(failed, { recursive: true, force: true });
      }
      throw error;
    }
    await writeFile(resultPath, JSON.stringify({ status: 'published', revision, inputHash, backup, fileCount: files.length, at: new Date().toISOString() }, null, 2));
    console.log(`Published ${files.length} documentation files from ${revision.slice(0, 8)}; local readback verified.`);
  } catch (error) {
    await writeFile(resultPath, JSON.stringify({ status: 'failed', error: error.message, at: new Date().toISOString() }, null, 2)); throw error;
  } finally { if (temp) await rm(temp, { recursive: true, force: true }); await rm(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const command = process.argv[2];
  try {
    if (command === 'install-hooks') await install();
    else if (command === 'publish') await publish();
    else if (command === 'build') {
      const index = process.argv.indexOf('--out'); if (index < 0 || !process.argv[index + 1]) throw Error('build requires --out <new empty directory>');
      const snap = await snapshot(false);
      try { console.log(JSON.stringify(await build(snap.source, path.resolve(process.argv[index + 1]), await git('rev-parse', 'HEAD')), null, 2)); }
      finally { await rm(snap.temp, { recursive: true, force: true }); }
    } else throw Error('Usage: node scripts/documentation-site.mjs build --out <empty-directory> | install-hooks | publish');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
