import { createReadStream } from 'fs';
import { readBody } from '../lib/utils.mjs';
import { PUBLIC_BASE_URL } from '../lib/config.mjs';
import { buildLocalHelperReleaseManifest, ensureLocalHelperRelease } from '../lib/local-helper-release.mjs';
import { getLocalBridgeDeviceByToken } from './local-bridge-store.mjs';
import {
  completeLocalBridgeCommandForDevice,
  createSessionLocalBridgeBootstrap,
  createSessionLocalBridgeCommand,
  createSessionLocalBridgePairing,
  finalizeLocalBridgeCommandStage,
  getSessionLocalBridgeCommandForClient,
  getSessionLocalBridgeStatus,
  heartbeatLocalBridgeDevice,
  pullNextLocalBridgeCommand,
  redeemSessionLocalBridgeBootstrap,
  redeemSessionLocalBridgePairing,
  uploadLocalBridgeCommandStage,
} from './local-bridge-session.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getBearerToken(req) {
  const header = trimString(req?.headers?.authorization);
  if (!header.startsWith('Bearer ')) return '';
  return trimString(header.slice(7));
}

function getLocalBridgeRoute(pathname = '') {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts.length < 2 || parts[0] !== 'api') return null;
  if (parts[1] === 'local-bridge') return { scope: 'device', parts };
  if (parts[1] === 'sessions' && parts[3] === 'local-bridge') return { scope: 'session', parts };
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRequestBaseUrl(req) {
  const forwardedProto = trimString(req?.headers?.['x-forwarded-proto']);
  const forwardedHost = trimString(req?.headers?.['x-forwarded-host']);
  const host = forwardedHost || trimString(req?.headers?.host);
  const protocol = forwardedProto || (req?.socket?.encrypted ? 'https' : 'http');
  if (!host) return trimString(PUBLIC_BASE_URL);
  return `${protocol}://${host}`;
}

async function authenticateDeviceRequest(req, deviceId) {
  const token = getBearerToken(req);
  if (!token) return null;
  const device = await getLocalBridgeDeviceByToken(token);
  if (!device || device.id !== trimString(deviceId)) return null;
  return device;
}

export async function handleLocalBridgePublicRoutes({
  req,
  res,
  pathname,
  parsedUrl,
  writeJson,
}) {
  const route = getLocalBridgeRoute(pathname);
  if (route?.scope !== 'device') return false;
  const { parts } = route;

  if (parts.length === 5 && parts[2] === 'helper' && parts[3] === 'releases' && req.method === 'GET') {
    const platform = trimString(parsedUrl?.query?.platform);
    const arch = trimString(parsedUrl?.query?.arch);
    if (!platform || !arch) {
      writeJson(res, 400, { error: 'platform and arch are required' });
      return true;
    }
    try {
      const release = await ensureLocalHelperRelease(platform, arch);
      if (parts[4] === 'latest') {
        writeJson(res, 200, buildLocalHelperReleaseManifest(release, resolveRequestBaseUrl(req)));
        return true;
      }
      if (parts[4] === 'download') {
        const requestedVersion = trimString(parsedUrl?.query?.version);
        if (requestedVersion && requestedVersion !== release.version) {
          writeJson(res, 404, { error: 'Requested helper release version not found' });
          return true;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(release.sizeBytes || 0),
          'Content-Disposition': `attachment; filename="${release.filename}"`,
          'Cache-Control': 'public, max-age=300',
          'X-RemoteLab-Helper-Version': release.version,
          'X-RemoteLab-Helper-Sha256': release.sha256,
        });
        createReadStream(release.binaryPath).pipe(res);
        return true;
      }
    } catch (error) {
      writeJson(res, error?.statusCode || 500, { error: error.message || 'Failed to resolve helper release' });
      return true;
    }
  }

  if (parts.length === 3 && parts[2] === 'pair' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 256 * 1024);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const redeemed = await redeemSessionLocalBridgePairing(trimString(payload?.code), payload || {});
      writeJson(res, 200, {
        device: {
          id: redeemed.device.id,
          token: redeemed.device.token,
          sessionId: redeemed.device.sessionId,
          platform: redeemed.device.platform,
          deviceName: redeemed.device.deviceName,
          helperVersion: redeemed.device.helperVersion,
          allowedRoots: redeemed.device.allowedRoots,
        },
      });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to redeem pairing code' });
    }
    return true;
  }

  if (parts.length === 4 && parts[2] === 'bootstrap' && parts[3] === 'redeem' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 256 * 1024);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const redeemed = await redeemSessionLocalBridgeBootstrap(trimString(payload?.token), payload || {});
      writeJson(res, 200, {
        device: {
          id: redeemed.device.id,
          token: redeemed.device.token,
          sessionId: redeemed.device.sessionId,
          platform: redeemed.device.platform,
          deviceName: redeemed.device.deviceName,
          helperVersion: redeemed.device.helperVersion,
          allowedRoots: redeemed.device.allowedRoots,
        },
      });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to redeem bootstrap token' });
    }
    return true;
  }

  const deviceId = trimString(parts[3]);
  if (!deviceId) return false;
  console.log(`[local-bridge-diag] device request: ${req.method} ${pathname} device=${deviceId}`);
  const device = await authenticateDeviceRequest(req, deviceId);
  if (!device) {
    console.log(`[local-bridge-diag] AUTH FAILED for device=${deviceId}`);
    writeJson(res, 401, { error: 'Device authorization required' });
    return true;
  }

  if (parts.length === 5 && parts[4] === 'heartbeat' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 256 * 1024);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const updated = await heartbeatLocalBridgeDevice(deviceId, payload || {});
      writeJson(res, 200, {
        device: {
          id: updated.id,
          sessionId: updated.sessionId,
          lastSeenAt: updated.lastSeenAt,
          platform: updated.platform,
          deviceName: updated.deviceName,
          helperVersion: updated.helperVersion,
          allowedRoots: updated.allowedRoots,
        },
      });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to update heartbeat' });
    }
    return true;
  }

  if (parts.length === 6 && parts[4] === 'commands' && parts[5] === 'next' && req.method === 'GET') {
    const timeoutMsRaw = Number.parseInt(trimString(parsedUrl?.query?.timeoutMs), 10);
    const timeoutMs = Number.isInteger(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(timeoutMsRaw, 30_000)
      : 0;
    const deadline = Date.now() + timeoutMs;
    console.log(`[local-bridge-diag] commands/next for device=${deviceId} timeoutMs=${timeoutMs}`);
    let command = await pullNextLocalBridgeCommand(deviceId);
    console.log(`[local-bridge-diag] first pull result: ${command ? command.id + ' (' + command.name + ')' : 'null'}`);
    while (!command && timeoutMs > 0 && Date.now() < deadline) {
      await sleep(200);
      command = await pullNextLocalBridgeCommand(deviceId);
    }
    if (command) console.log(`[local-bridge-diag] returning command ${command.id} (${command.name})`);
    writeJson(res, 200, { command });
    return true;
  }

  const commandId = trimString(parts[5]);
  if (!commandId) return false;

  if (parts.length === 7 && parts[4] === 'commands' && parts[6] === 'result' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 1024 * 1024);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const command = await completeLocalBridgeCommandForDevice(deviceId, commandId, payload || {});
      writeJson(res, 200, { command });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to submit command result' });
    }
    return true;
  }

  if (parts.length === 7 && parts[4] === 'commands' && parts[6] === 'upload' && (req.method === 'PUT' || req.method === 'POST')) {
    try {
      const asset = await uploadLocalBridgeCommandStage(deviceId, commandId, req);
      writeJson(res, 200, { asset: { id: asset?.id || '' } });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to upload staged file' });
    }
    return true;
  }

  if (parts.length === 8 && parts[4] === 'commands' && parts[6] === 'upload' && parts[7] === 'finalize' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 256 * 1024);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const asset = await finalizeLocalBridgeCommandStage(deviceId, commandId, payload || {});
      writeJson(res, 200, { asset });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to finalize staged file' });
    }
    return true;
  }

  return false;
}

export async function handleLocalBridgeOwnerRoutes({
  req,
  res,
  pathname,
  authSession,
  requireSessionAccess,
  writeJson,
}) {
  const route = getLocalBridgeRoute(pathname);
  if (route?.scope !== 'session') return false;
  const { parts } = route;
  const sessionId = trimString(parts[2]);
  if (!sessionId) return false;
  if (!await requireSessionAccess(res, authSession, sessionId)) return true;

  if (parts.length === 5 && parts[4] === 'status' && req.method === 'GET') {
    try {
      const localBridge = await getSessionLocalBridgeStatus(sessionId);
      writeJson(res, 200, { localBridge });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to load local bridge status' });
    }
    return true;
  }

  if (parts.length === 5 && parts[4] === 'pairing-code' && req.method === 'POST') {
    try {
      const pairing = await createSessionLocalBridgePairing(sessionId);
      writeJson(res, 201, { pairing });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to create pairing code' });
    }
    return true;
  }

  if (parts.length === 5 && parts[4] === 'bootstrap' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 256 * 1024);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const bootstrap = await createSessionLocalBridgeBootstrap(sessionId, payload || {});
      writeJson(res, 201, { bootstrap });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to create local bridge bootstrap token' });
    }
    return true;
  }

  if (parts.length === 5 && parts[4] === 'commands' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 1024 * 1024);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const command = await createSessionLocalBridgeCommand(sessionId, payload || {});
      writeJson(res, 202, { command });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to queue local bridge command' });
    }
    return true;
  }

  const commandId = trimString(parts[5]);
  if (parts.length === 6 && parts[4] === 'commands' && commandId && req.method === 'GET') {
    try {
      const command = await getSessionLocalBridgeCommandForClient(sessionId, commandId);
      if (!command) {
        writeJson(res, 404, { error: 'Command not found' });
        return true;
      }
      writeJson(res, 200, { command });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to load command' });
    }
    return true;
  }

  return false;
}
