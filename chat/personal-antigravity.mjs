import { createHash, randomBytes } from 'node:crypto';

export const PERSONAL_ANTIGRAVITY_TOOL = 'antigravity-personal';
export const PERSONAL_ANTIGRAVITY_API = '/api/personal-antigravity';
export const personalAntigravityEnabled = process.env.REMOTELAB_PERSONAL_ANTIGRAVITY === '1';
const pairingTTL = 300_000;
const jobTTL = 240_000;
const pollTimeout = 25_000;
const idleTTL = jobTTL + 2 * pollTimeout;
const secret = () => randomBytes(24).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

export function createPersonalAntigravityRelay() {
  const pairs = new Map();
  const codes = new Map();
  const devices = new Map();
  const tokens = new Map();

  function removePair(pair) {
    if (!pair) return;
    clearTimeout(pair.timer);
    pairs.delete(pair.personId);
    codes.delete(pair.key);
  }

  function disconnect(personId) {
    removePair(pairs.get(personId));
    const device = devices.get(personId);
    if (!device) return;
    devices.delete(personId);
    tokens.delete(device.key);
    clearTimeout(device.timer);
    device.wake?.();
    for (const job of device.jobs.values()) job.finish(fail('个人 Antigravity 已断开。'));
  }

  function pair(personId) {
    removePair(pairs.get(personId));
    const code = secret();
    const pair = { personId, key: hash(code) };
    pair.timer = setTimeout(() => removePair(pair), pairingTTL);
    pair.timer.unref();
    pairs.set(personId, pair);
    codes.set(pair.key, pair);
    return { code, expiresInSeconds: pairingTTL / 1000 };
  }

  function refresh(device) {
    clearTimeout(device.timer);
    device.timer = setTimeout(() => disconnect(device.personId), idleTTL);
    device.timer.unref();
  }

  function redeem(code) {
    const pair = codes.get(hash(code));
    if (!pair) throw fail('连接码无效或已过期。', 403);
    disconnect(pair.personId);
    const token = secret();
    const device = { id: secret(), key: hash(token), personId: pair.personId, jobs: new Map() };
    devices.set(device.personId, device);
    tokens.set(device.key, device);
    refresh(device);
    return { token };
  }

  function authenticate(token) {
    const device = tokens.get(hash(token));
    if (!device) throw fail('设备已断开，请重新连接。', 403);
    refresh(device);
    return device;
  }

  function status(personId) {
    return { connected: devices.has(personId) };
  }

  function requireDevice(personId) {
    const device = devices.get(personId);
    if (!device) throw fail('请在 Index 设置的「我的 Antigravity」连接已登录 Google 的电脑。');
    return device.id;
  }

  async function run(personId, deviceId, input, signal) {
    const device = devices.get(personId);
    if (!device || device.id !== deviceId) throw fail('原个人 Antigravity 连接已关闭，请重新发送。');
    if (signal?.aborted) throw fail('Index 已停止这次调用。');
    return new Promise((resolve, reject) => {
      const id = secret();
      const onAbort = () => finish(fail('Index 已停止这次调用。'));
      const timer = setTimeout(() => finish(fail('等待本机 Antigravity 超时，请检查终端并重新发送。')), jobTTL);
      timer.unref();
      function finish(error, response) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        device.jobs.get(id)?.notify?.();
        device.jobs.delete(id);
        if (error) reject(error);
        else resolve(response);
      }
      device.jobs.set(id, { id, input, finish, claimed: false });
      signal?.addEventListener('abort', onAbort, { once: true });
      device.wake?.();
    });
  }

  async function next(device, signal) {
    if (device.wake) throw fail('设备已在等待任务。');
    const nextJob = () => [...device.jobs.values()].find(job => !job.claimed);
    if (!nextJob() && !signal?.aborted) {
      await new Promise(resolve => {
        const timer = setTimeout(wake, pollTimeout);
        signal?.addEventListener('abort', wake, { once: true });
        function wake() {
          clearTimeout(timer);
          signal?.removeEventListener('abort', wake);
          device.wake = null;
          resolve();
        }
        device.wake = wake;
      });
    }
    if (devices.get(device.personId) !== device || signal?.aborted) return null;
    const job = nextJob();
    if (!job) return null;
    // A claimed request is never redelivered, even if the response was lost.
    job.claimed = true;
    return { id: job.id, ...job.input };
  }

  function start(device, id) {
    const job = device.jobs.get(id);
    if (!job?.claimed || job.started) throw fail('任务已结束或不属于这台设备。', 404);
    job.started = true;
  }

  async function watch(device, id, signal) {
    const job = device.jobs.get(id);
    if (!job?.started) return false;
    if (job.notify) throw fail('设备已在等待任务结束。');
    if (!signal?.aborted) {
      await new Promise(resolve => {
        const timer = setTimeout(notify, pollTimeout);
        signal?.addEventListener('abort', notify, { once: true });
        function notify() {
          clearTimeout(timer);
          signal?.removeEventListener('abort', notify);
          job.notify = null;
          resolve();
        }
        job.notify = notify;
      });
    }
    return device.jobs.has(id);
  }

  function complete(device, { id, response, error }) {
    const job = device.jobs.get(id);
    if (!job?.claimed) throw fail('任务已结束或不属于这台设备。', 404);
    if (typeof error === 'string' && error) job.finish(fail(error.slice(0, 300)));
    else if (job.started && typeof response === 'string' && response.trim() && response.length <= 150_000) job.finish(null, response);
    else throw fail('本机返回的结果无效。', 400);
  }

  return { status, pair, redeem, disconnect, requireDevice, authenticate, run, next, start, watch, complete };
}

export const personalAntigravity = createPersonalAntigravityRelay();
