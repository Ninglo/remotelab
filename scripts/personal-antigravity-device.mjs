import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const deny = ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'mcp(*)'];
const settings = JSON.stringify({ permissions: { allow: [], ask: [], deny }, toolPermission: 'strict', allowNonWorkspaceAccess: false, useG1Credits: false });

async function main() {
  if (!process.stdin.isTTY) throw new Error('请在自己的电脑上打开终端运行此程序。');
  const profile = join(homedir(), '.remotelab', 'personal-antigravity');
  await mkdir(profile, { mode: 0o700, recursive: true });
  await chmod(profile, 0o700);
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'DISPLAY', 'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_CONNECTION', 'SSH_TTY', 'BROWSER', 'TMPDIR']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: profile, XDG_CONFIG_HOME: join(profile, 'config'), XDG_CACHE_HOME: join(profile, 'cache') });

  if (process.argv[2] === '--login') {
    const { spawn } = await import('node:child_process');
    const child = spawn('agy', [], { cwd: profile, env, stdio: 'inherit' });
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error('Antigravity 登录终端已关闭。')));
    });
    return;
  }
  const base = new URL(process.argv[2] || '');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('请使用 Index 提供的 HTTPS 地址。');
  }
  const endpoint = base.href.replace(/\/$/, '') + '/api/personal-antigravity/device/';
  const tty = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const stop = new AbortController();
  tty.on('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  let token;
  const conversations = new Map();
  async function call(action, payload = {}, signal = stop.signal) {
    const response = await fetch(endpoint + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(payload), redirect: 'error', signal,
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Index 连接失败。'), { status: response.status });
    return data;
  }
  const work = await mkdtemp(join(tmpdir(), 'index-antigravity-'));
  try {
    const code = (await tty.question('粘贴 Index 页面显示的一次性连接码：', { signal: stop.signal })).trim();
    if (!/^[A-Za-z0-9_-]{32}$/.test(code)) throw new Error('连接码格式无效。');
    ({ token } = await call('redeem', { code }));
    console.log('已连接 Index。每条请求须在本机确认。按 Ctrl+C 断开。');
    while (!stop.signal.aborted) {
      const { job } = await call('next');
      if (!job) continue;
      // Escape terminal control characters in untrusted request text.
      console.log('Index 请求 ' + JSON.stringify(job.prompt).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '?'));
      const answer = await tty.question('用本机 Google 账号执行？输入 y 确认：', { signal: stop.signal });
      let result = { error: '本机用户未确认这次请求。' };
      if (answer.trim().toLowerCase() === 'y') {
        try {
          await call('start', { id: job.id });
          const args = ['--disable-slash-commands', '--mode', 'plan', '--settings', settings,
            '--print', job.prompt, '--output-format', 'json'];
          if (job.fresh) conversations.delete(job.session);
          const conversation = conversations.get(job.session);
          if (conversation) args.push('--conversation', conversation);
          if (job.model) args.push('--model', job.model);
          if (job.effort) args.push('--effort', job.effort);
          const finished = new AbortController();
          const revoked = new AbortController();
          const watchSignal = AbortSignal.any([stop.signal, finished.signal]);
          const monitor = (async () => {
            while (!watchSignal.aborted) {
              if (!(await call('watch', { id: job.id }, watchSignal)).active) {
                revoked.abort();
                break;
              }
            }
          })().catch(() => { if (!watchSignal.aborted) revoked.abort(); });
          const signal = AbortSignal.any([stop.signal, revoked.signal, AbortSignal.timeout(180_000)]);
          let stdout;
          try {
            ({ stdout } = await exec('agy', args, { cwd: work, env, signal, maxBuffer: 2 * 1024 * 1024 }));
          } finally {
            finished.abort();
            await monitor;
          }
          const { status, response, conversation_id } = JSON.parse(stdout);
          if (status !== 'SUCCESS' || typeof response !== 'string' || !response.trim()) throw new Error('Antigravity returned no answer');
          if (typeof conversation_id === 'string' && conversation_id) conversations.set(job.session, conversation_id);
          result = { response };
        } catch (error) {
          if (error.status === 404) {
            console.log('这条请求已在 Index 结束。');
            continue;
          }
          result = { error: '本机 Antigravity 调用失败。请检查 Google 登录、所选模型和额度。' };
        }
      }
      try {
        await call('result', { id: job.id, ...result });
      } catch (error) {
        if (error.status !== 404) throw error;
        console.log('这条请求已在 Index 结束。');
      }
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    if (token) await call('disconnect', {}, AbortSignal.timeout(2_000)).catch(() => {});
    tty.close();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  console.error(error.code === 'ENOENT' ? '未找到 agy，请先安装 Antigravity CLI 并加入 PATH。' : error.message);
  process.exitCode = 1;
});
