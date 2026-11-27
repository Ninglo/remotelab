import { open, readFile } from 'node:fs/promises';
import { readBody } from '../lib/utils.mjs';
import { join } from 'node:path';
import { personalWorkspace } from './feishu-personal-workspace.mjs';
import { requests } from './requests.mjs';
import { buildPersonalAntigravityPrompt } from './personal-antigravity-context.mjs';
import { rankIndexReferences } from './session-log-search.mjs';
import { getRun, getRunManifest, runDir } from './runs.mjs';
import {
  PERSONAL_ANTIGRAVITY_API, PERSONAL_ANTIGRAVITY_TOOL, personalAntigravity, personalAntigravityEnabled,
} from './personal-antigravity.mjs';

const credential = /^[A-Za-z0-9_-]{32}$/;
const relayPath = PERSONAL_ANTIGRAVITY_API + '/device/';
const abortedOnClose = res => {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  return controller.signal;
};
const body = async req => JSON.parse(await readBody(req, 1024 * 1024) || '{}');

export async function handlePersonalAntigravityDeviceRoutes({ req, res, pathname, writeJson, relay = personalAntigravity }) {
  if (!pathname.startsWith(relayPath)) return false;
  res.setHeader('Cache-Control', 'private, no-store');
  if (!personalAntigravityEnabled || req.method !== 'POST') {
    writeJson(res, 404, { error: '个人 Antigravity 设备入口未启用。' });
    return true;
  }
  try {
    const action = pathname.slice(relayPath.length);
    if (action === 'redeem') {
      const { code } = await body(req);
      if (!credential.test(code || '')) {
        writeJson(res, 403, { error: '连接码无效。' });
        return true;
      }
      writeJson(res, 200, relay.redeem(code));
      return true;
    }
    const token = /^Bearer ([A-Za-z0-9_-]{32})$/.exec(req.headers.authorization || '')?.[1];
    if (!token) {
      writeJson(res, 403, { error: '需要已绑定设备凭据。' });
      return true;
    }
    const device = relay.authenticate(token);
    if (action === 'next') {
      const job = await relay.next(device, abortedOnClose(res));
      if (!res.destroyed) writeJson(res, 200, { job });
    } else if (action === 'start') {
      relay.start(device, (await body(req)).id);
      writeJson(res, 200, { ok: true });
    } else if (action === 'watch') {
      const { id } = await body(req);
      const active = await relay.watch(device, id, abortedOnClose(res));
      if (!res.destroyed) writeJson(res, 200, { active });
    } else if (action === 'result') {
      relay.complete(device, await body(req));
      writeJson(res, 200, { ok: true });
    } else if (action === 'disconnect') {
      relay.disconnect(device.personId);
      writeJson(res, 200, { ok: true });
    } else writeJson(res, 404, { error: '设备操作不存在。' });
  } catch (error) {
    if (!res.destroyed) writeJson(res, error.status || 400, { error: error.status ? error.message : '设备请求无效。' });
  }
  return true;
}

export async function handlePersonalAntigravityRoutes({ req, res, pathname, authSession, writeJson, relay = personalAntigravity }) {
  if (!pathname.startsWith(PERSONAL_ANTIGRAVITY_API + '/')) return false;
  res.setHeader('Cache-Control', 'private, no-store');
  if (!personalAntigravityEnabled) {
    writeJson(res, 404, { error: '个人 Antigravity 尚未启用。' });
    return true;
  }
  const action = pathname.slice(PERSONAL_ANTIGRAVITY_API.length + 1);
  try {
    if (action === 'run' && req.method === 'POST' && authSession?.authKind === 'service') {
      const { runId } = await body(req);
      if (!/^run_[a-f0-9]{24}$/.test(runId || '')) {
        writeJson(res, 400, { error: '无效的运行 ID。' });
        return true;
      }
      const [run, manifest] = await Promise.all([getRun(runId), getRunManifest(runId)]);
      if (manifest?.tool !== PERSONAL_ANTIGRAVITY_TOOL || !manifest.personalAntigravityDeviceId
          || !manifest.viewPersonId || run?.state !== 'running' || run.cancelRequested) {
        writeJson(res, 403, { error: '没有可执行的个人 Antigravity 请求。' });
        return true;
      }
      const signal = abortedOnClose(res);
      try {
        const attempt = await open(join(runDir(runId), 'personal-antigravity-attempt'), 'wx', 0o600);
        await attempt.close();
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        writeJson(res, 409, { error: '请求已转发，避免重复执行。请重新发送。' });
        return true;
      }
      const record = await requests.byRequest(manifest.sessionId, manifest.requestId);
      if (record?.runId !== runId || record.options?.viewPersonId !== manifest.viewPersonId) {
        writeJson(res, 403, { error: '无法核验个人 Antigravity 请求的发起人。' });
        return true;
      }
      const prompt = await buildPersonalAntigravityPrompt(record, manifest.prompt, signal);
      const response = await relay.run(manifest.viewPersonId, manifest.personalAntigravityDeviceId, {
        prompt, session: manifest.sessionId,
        fresh: manifest.personalAntigravityFreshThread === true, model: manifest.options?.model || '', effort: manifest.options?.effort || '',
      }, signal);
      if (!res.destroyed) writeJson(res, 200, { response });
      return true;
    }
    const personId = authSession?.personId;
    if (!personId || personId === 'person_system' || authSession.authKind === 'service') {
      writeJson(res, 403, { error: '请使用本人的 Index 账号登录。' });
      return true;
    }
    if (action === 'context' && req.method === 'GET') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const kind = params.get('kind');
      const query = params.get('q')?.trim();
      if (!['project-memory', 'work-summary'].includes(kind) || !query || query.length > 1000) {
        writeJson(res, 400, { error: '请选择来源并输入搜索关键词。' });
        return true;
      }
      const { records, incomplete } = await personalWorkspace.referenceSources(authSession, kind);
      writeJson(res, 200, { references: rankIndexReferences(records, query), incomplete });
    } else if (action === 'status' && req.method === 'GET') {
      writeJson(res, 200, relay.status(personId));
    } else if ((action === 'pair' || action === 'disconnect') && req.method === 'POST'
        && req.headers['content-type']?.startsWith('application/json')) {
      if (action === 'disconnect') relay.disconnect(personId);
      writeJson(res, 200, action === 'pair' ? relay.pair(personId) : relay.status(personId));
    } else if (action === 'worker' && req.method === 'GET') {
      const file = await readFile(new URL('../scripts/personal-antigravity-device.mjs', import.meta.url));
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="personal-antigravity-device.mjs"',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(file);
    } else writeJson(res, 404, { error: '个人 Antigravity 操作不存在。' });
  } catch (error) {
    if (!res.destroyed) writeJson(res, error.status || 400, { error: error.status ? error.message : '个人 Antigravity 调用失败。' });
  }
  return true;
}
