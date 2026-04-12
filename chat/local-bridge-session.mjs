import { basename } from 'path';

import { createFileAssetUploadIntent, finalizeFileAssetUpload, getFileAsset, getFileAssetForClient, ingestFileAssetUpload } from './file-assets.mjs';
import {
  claimNextLocalBridgeCommand,
  completeLocalBridgeCommand,
  createLocalBridgeBootstrapToken,
  createLocalBridgePairingCode,
  getLocalBridgeCommand,
  getLocalBridgeDevice,
  getSessionLocalBridgeCommand,
  getSessionLocalBridgeSurface,
  recordLocalBridgeHeartbeat,
  redeemLocalBridgeBootstrapToken,
  redeemLocalBridgePairingCode,
  enqueueLocalBridgeCommand,
} from './local-bridge-store.mjs';
import { appendAssistantMessage, getSession } from './session-manager.mjs';
import { findSessionMeta, mutateSessionMeta } from './session-meta-store.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function assertSessionExists(session) {
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  return session;
}

function createClientCommand(command) {
  if (!command) return null;
  return {
    id: command.id,
    sessionId: command.sessionId,
    deviceId: command.deviceId,
    name: command.name,
    state: command.state,
    createdAt: command.createdAt,
    claimedAt: command.claimedAt,
    completedAt: command.completedAt,
    args: command.args,
    result: command.result,
    error: command.error || '',
  };
}

function buildStageOriginalName(relPath) {
  return basename(trimString(relPath) || 'attachment');
}

export async function createSessionLocalBridgePairing(sessionId) {
  const session = assertSessionExists(await findSessionMeta(sessionId));
  const pairing = await createLocalBridgePairingCode(session.id);
  return {
    ...pairing,
    sessionId: session.id,
  };
}

export async function createSessionLocalBridgeBootstrap(sessionId, extra = {}) {
  const session = assertSessionExists(await findSessionMeta(sessionId));
  const bootstrap = await createLocalBridgeBootstrapToken(session.id, extra);
  return {
    ...bootstrap,
    sessionId: session.id,
  };
}

export async function redeemSessionLocalBridgePairing(code, extra = {}) {
  const redeemed = await redeemLocalBridgePairingCode(code, extra);
  const sessionId = trimString(redeemed?.device?.sessionId);
  const deviceId = trimString(redeemed?.device?.id);
  if (!sessionId || !deviceId) {
    const error = new Error('Failed to redeem local bridge pairing code');
    error.statusCode = 400;
    throw error;
  }
  await mutateSessionMeta(sessionId, (draft) => {
    draft.localBridgeDeviceId = deviceId;
    draft.updatedAt = new Date().toISOString();
    return true;
  });
  return redeemed;
}

export async function redeemSessionLocalBridgeBootstrap(token, extra = {}) {
  const redeemed = await redeemLocalBridgeBootstrapToken(token, extra);
  const sessionId = trimString(redeemed?.device?.sessionId);
  const deviceId = trimString(redeemed?.device?.id);
  if (!sessionId || !deviceId) {
    const error = new Error('Failed to redeem local bridge bootstrap token');
    error.statusCode = 400;
    throw error;
  }
  await mutateSessionMeta(sessionId, (draft) => {
    draft.localBridgeDeviceId = deviceId;
    draft.updatedAt = new Date().toISOString();
    return true;
  });
  return redeemed;
}

export async function getSessionLocalBridgeStatus(sessionId) {
  const session = assertSessionExists(await getSession(sessionId));
  return await getSessionLocalBridgeSurface(session);
}

export async function heartbeatLocalBridgeDevice(deviceId, extra = {}) {
  const device = await recordLocalBridgeHeartbeat(deviceId, extra);
  if (!device) {
    const error = new Error('Device not found');
    error.statusCode = 404;
    throw error;
  }
  return device;
}

export async function pullNextLocalBridgeCommand(deviceId) {
  return await claimNextLocalBridgeCommand(deviceId);
}

export async function createSessionLocalBridgeCommand(sessionId, payload = {}) {
  const session = assertSessionExists(await findSessionMeta(sessionId));
  const deviceId = trimString(session.localBridgeDeviceId);
  if (!deviceId) {
    const error = new Error('Session has no linked local helper');
    error.statusCode = 409;
    throw error;
  }
  const device = await getLocalBridgeDevice(deviceId);
  if (!device) {
    const error = new Error('Linked local helper not found');
    error.statusCode = 404;
    throw error;
  }
  const name = trimString(payload?.name);
  const args = payload?.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : {};
  if (!name) {
    const error = new Error('name is required');
    error.statusCode = 400;
    throw error;
  }

  let stageAssetId = '';
  if (name === 'stage' || name === 'pack') {
    const relPath = trimString(args.relPath);
    if (!trimString(args.rootAlias) || !relPath) {
      const error = new Error(`${name} requires rootAlias and relPath`);
      error.statusCode = 400;
      throw error;
    }
    const originalName = name === 'pack'
      ? `${relPath.replace(/[\\/]/g, '_').replace(/^_+|_+$/g, '')}.tar.gz`
      : buildStageOriginalName(relPath);
    const intent = await createFileAssetUploadIntent({
      sessionId: session.id,
      originalName,
      mimeType: name === 'pack' ? 'application/gzip' : trimString(args.mimeType),
      sizeBytes: args.sizeBytes,
      createdBy: 'owner',
      forceLocal: true,
    });
    stageAssetId = trimString(intent?.asset?.id);
  }

  return createClientCommand(await enqueueLocalBridgeCommand({
    sessionId: session.id,
    deviceId: device.id,
    name,
    args,
    stageAssetId,
  }));
}

export async function getSessionLocalBridgeCommandForClient(sessionId, commandId) {
  return createClientCommand(await getSessionLocalBridgeCommand(sessionId, commandId));
}

async function getStageAssetForDeviceCommand(deviceId, commandId) {
  const command = await getLocalBridgeCommand(commandId);
  if (!command || command.deviceId !== trimString(deviceId)) {
    const error = new Error('Command not found');
    error.statusCode = 404;
    throw error;
  }
  if (!command.stageAssetId) {
    const error = new Error('Command has no staged asset');
    error.statusCode = 400;
    throw error;
  }
  return { command, assetId: command.stageAssetId };
}

export async function uploadLocalBridgeCommandStage(deviceId, commandId, req) {
  const { assetId } = await getStageAssetForDeviceCommand(deviceId, commandId);
  await ingestFileAssetUpload(assetId, req);
  return await getFileAsset(assetId);
}

export async function finalizeLocalBridgeCommandStage(deviceId, commandId, payload = {}) {
  const { assetId } = await getStageAssetForDeviceCommand(deviceId, commandId);
  return await finalizeFileAssetUpload(assetId, {
    sizeBytes: payload?.sizeBytes,
    etag: trimString(payload?.etag),
  });
}

export async function completeLocalBridgeCommandForDevice(deviceId, commandId, payload = {}) {
  const command = await getLocalBridgeCommand(commandId);
  if (!command || command.deviceId !== trimString(deviceId)) {
    const error = new Error('Command not found');
    error.statusCode = 404;
    throw error;
  }
  let nextPayload = payload;
  if (command.stageAssetId && !trimString(payload?.error)) {
    const clientAsset = await getFileAssetForClient(command.stageAssetId, { includeDirectUrl: true });
    nextPayload = {
      ...payload,
      result: {
        ...(payload?.result && typeof payload.result === 'object' ? payload.result : {}),
        asset: clientAsset,
      },
    };
  }
  const completed = await completeLocalBridgeCommand(deviceId, commandId, nextPayload);
  if (!completed) {
    const error = new Error('Command not found');
    error.statusCode = 404;
    throw error;
  }
  if (command.stageAssetId && !trimString(payload?.error)) {
    const asset = await getFileAssetForClient(command.stageAssetId, { includeDirectUrl: true });
    await appendAssistantMessage(command.sessionId, '', [], {
      preSavedAttachments: [{
        assetId: asset.id,
        originalName: asset.originalName,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
      }],
      source: 'local_bridge_stage',
    });
  }
  return createClientCommand(completed);
}
