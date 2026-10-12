import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../chat/fs-utils.mjs';
import { assertWorkboardOwnerStopped, upgradeFeishuWorkboardState } from './workboard-runtime.mjs';
import { createFeishuWorkboardSync } from './workboard-sync.mjs';

// The connector's exclusive PID lock owns this component too. Migration must
// retire legacy writers first; refuse a still-live legacy owner as a second fence.
export async function startFeishuWorkboards(runtime, { configDir, configPath, remote,
  createSync = createFeishuWorkboardSync } = {}) {
  const route = runtime.config.sourceRouteId;
  if (!/^[a-zA-Z0-9_-]+$/.test(route)) throw new Error('Invalid card route');
  const statePath = join(configDir, 'workboards', `feishu-${route}.json`);
  const healthPath = join(runtime.config.storageDir, 'workboard-health.json');
  let status = { state: 'starting', pid: process.pid };
  let component = null;
  const onStatus = async value => {
    status = { ...value, owner: 'connector', sourceRouteId: route };
    await writeJsonAtomic(healthPath, status, { mode: 0o600 }).catch(error =>
      console.error(`[feishu-connector] cannot persist card health: ${error.message}`));
  };
  try {
    let previous = {};
    try { previous = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assertWorkboardOwnerStopped(previous);
    const pilot = upgradeFeishuWorkboardState(previous, { sourceRouteId: route, botConfigPath: configPath });
    // Persist ownership before any subscription or provider operation.
    pilot.runtime = { owner: 'connector', pid: process.pid, startedAt: new Date().toISOString() };
    await writeJsonAtomic(statePath, pilot, { mode: 0o600 });
    component = await createSync({ statePath, pilot, app: runtime.appClient, remote, onStatus });
  } catch (error) {
    await onStatus({ state: 'failed', pid: process.pid, error: error.message, updatedAt: new Date().toISOString() });
    console.error(`[feishu-connector] cards unavailable: ${error.message}`);
  }
  return {
    getStatus: () => structuredClone(status),
    async stop() { if (component) await component.stop(); },
  };
}

export function describeFeishuWorkboards(runtime) {
  const health = runtime.workboards?.getStatus();
  if (!health) return '';
  const labels = { ready: '正常', starting: '启动中', reconnecting: '连接恢复中', degraded: '部分投递异常',
    quota_blocked: '因飞书额度暂停', failed: '启动失败', stopped: '已停止' };
  return `\n卡片同步：${labels[health.state] || health.state}`;
}
