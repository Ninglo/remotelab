import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, statfs, realpath, lstat, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

const exec = promisify(execFile);
const GiB = 1024 ** 3;
async function command(file, args, signal) {
  try {
    const { stdout, stderr } = await exec(file, args, { timeout: 15_000, signal, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '', killed: !!error.killed };
  }
}

async function measure(path) {
  const [fs, info] = await Promise.all([statfs(path), stat(path)]);
  const availableBytes = fs.bavail * fs.bsize;
  return { path, device: info.dev, availableBytes,
    usedPercent: (fs.blocks - fs.bfree) / (fs.blocks - fs.bfree + fs.bavail) * 100,
    inodeUsedPercent: fs.files > 0 ? (fs.files - fs.ffree) / fs.files * 100 : null };
}

async function uvCacheSafe(root, uid) {
  // uv legitimately uses symlinks internally; let its native, non-forced
  // prune deal with locks and links. Never direct it at a mounted subtree.
  const tagPath = join(root, 'CACHEDIR.TAG');
  const tag = await lstat(tagPath);
  if (!tag.isFile() || tag.uid !== uid || tag.size > 4096) return false;
  if (!(await readFile(tagPath, 'utf8')).startsWith('Signature: 8a477f597d28d172789f06886806bc55')) return false;
  const mounts = await readFile('/proc/self/mountinfo', 'utf8');
  return mounts.trim().split('\n').every(line => {
    const encoded = line.split(' ')[4];
    if (!encoded?.startsWith('/')) return false;
    const target = encoded.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    return !target.startsWith(`${root}/`);
  });
}

// Only explicitly configured package caches are executable policy. Unique
// data, environments outside these caches, and migrations stay out of scope.
export async function maintainDisk({ path, config, run: execute = command, inspect = stat,
  resolve = realpath, readDisk = measure, checkUv = uvCacheSafe, uid = process.getuid?.() } = {}) {
  const signal = AbortSignal.timeout(config.maxDurationMs || 30_000);
  const run = (file, args) => { signal.throwIfAborted(); return execute(file, args, signal); };
  const before = await readDisk(path), actions = [];
  const budget = Number.isFinite(config.maxBytes) && config.maxBytes > 0 ? config.maxBytes : 10 * GiB;
  let selectedBytes = 0;
  for (const cache of config.caches || []) {
    const action = { kind: cache.kind, path: cache.path, status: 'skipped' }; actions.push(action);
    try {
      if (!['npm', 'pip', 'uv'].includes(cache.kind) || typeof cache.path !== 'string' || !isAbsolute(cache.path)) {
        action.reason = 'unsupported_cache'; continue;
      }
      const root = await resolve(cache.path);
      const content = cache.kind === 'npm' ? join(root, '_cacache') : root;
      const info = await inspect(content);
      if (!info.isDirectory()) { action.reason = 'not_directory'; continue; }
      if (info.uid !== uid) { action.reason = 'owner_mismatch'; continue; }
      if (info.dev !== before.device) { action.reason = 'different_filesystem'; continue; }
      if (cache.kind === 'uv') {
        if (root !== cache.path || (info.mode & 0o022) !== 0 || !await checkUv(root, uid)) {
          action.reason = 'unverified_uv_cache'; continue;
        }
      } else {
        // Reject foreign-owned entries, links and nested mounts; incomplete
        // reads never authorize the less selective npm/pip commands.
        const ownership = await run('find', [content, '-xdev', '(', '!', '-uid', String(uid), '-o', '-type', 'l', ')', '-print', '-quit']);
        if (ownership.code !== 0 || ownership.stderr || ownership.stdout.trim()) { action.reason = 'unverified_cache_tree'; continue; }
        const devices = await run('find', [content, '-xdev', '-type', 'd', '-printf', '%D\n']);
        if (devices.code !== 0 || devices.stderr || devices.stdout.trim().split('\n').some(dev => dev !== String(info.dev))) {
          action.reason = 'nested_mount_or_incomplete_read'; continue;
        }
      }
      const size = await run('du', ['-sxB1', content]);
      const bytes = Number(size.stdout.split(/\s/)[0]);
      if (size.code !== 0 || !Number.isFinite(bytes) || bytes < 0) { action.reason = 'size_unknown'; continue; }
      action.candidateBytes = bytes;
      if (selectedBytes + bytes > budget) { action.reason = 'round_budget'; continue; }
      if (bytes <= 4096) { action.reason = 'empty'; continue; }
      // Test the installed tool's own cache location before invoking its
      // official purge. No shell interpolation and no recursive rm fallback.
      const tools = {
        npm: ['npm', ['--cache', root, 'config', 'get', 'cache'], ['--cache', root, 'cache', 'clean', '--force']],
        pip: ['python3', ['-m', 'pip', '--cache-dir', root, 'cache', 'dir'], ['-m', 'pip', '--cache-dir', root, 'cache', 'purge']],
        uv: ['uv', ['cache', 'dir'], ['cache', 'prune', '--cache-dir', root]],
      };
      const [tool, locate, clean] = tools[cache.kind];
      const location = await run(tool, locate);
      if (location.code !== 0 || await resolve(location.stdout.trim()) !== root) { action.reason = 'tool_cache_mismatch'; continue; }
      if (cache.kind !== 'uv') {
        const processes = await run('ps', ['-u', String(uid), '-o', 'args=']);
        const installing = /(?:^|\s)(?:npm|npx|pnpm|yarn)(?:\s|$)|(?:^|\s)pip[0-9.]*(?:\s|$)|python[0-9.]*\s+-m\s+pip(?:\s|$)/m;
        if (processes.code !== 0 || installing.test(processes.stdout)) { action.reason = 'package_process_active_or_unknown'; continue; }
        const handles = await run('lsof', ['-nP', '+D', content]);
        if (handles.code !== 1 || handles.stdout.trim() || handles.stderr.trim() || handles.killed) {
          action.reason = 'open_handles_or_incomplete_read'; continue;
        }
      }
      const prior = await readDisk(path);
      const result = await run(tool, clean);
      selectedBytes += bytes;
      action.exitCode = result.code; action.output = (result.stdout + result.stderr).slice(0, 2000);
      const after = await readDisk(path);
      action.availableBytesDelta = after.availableBytes - prior.availableBytes;
      action.status = result.code !== 0 ? 'failed'
        : cache.kind === 'uv' && /\bNo unused entries found\b/i.test(action.output) ? 'unchanged' : 'cleaned';
      if (result.code !== 0) break; // uncertain/partial purge is not replayed
      if (after.usedPercent < 85 && after.inodeUsedPercent < 85
        && after.availableBytes >= (path === '/' ? 15 : 50) * GiB) break;
    } catch (error) { action.reason = error.code || 'CACHE_CHECK_FAILED'; }
  }
  const after = await readDisk(path);
  const cleaned = actions.filter(a => a.status === 'cleaned').length;
  return { observedAt: new Date().toISOString(), before, after, actions,
    availableBytesDelta: after.availableBytes - before.availableBytes,
    summary: `脚本已检查${actions.length}项授权包缓存，清理${cleaned}项；磁盘可用净变化${((after.availableBytes - before.availableBytes) / GiB).toFixed(3)} GiB（包含并发写入）。等待独立观测确认是否恢复。` };
}
