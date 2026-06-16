import { readdir } from 'fs/promises';
import { join } from 'path';

import { CONFIG_DIR } from './config.mjs';
import { ensureDir, readJson, removePath, writeJsonAtomic } from '../chat/fs-utils.mjs';

export const CONNECTOR_SURFACES_DIR = join(CONFIG_DIR, 'connector-surfaces');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value) {
  return trimString(value).replace(/\/+$/, '');
}

function normalizePath(value, fallback = '/') {
  const normalized = `/${trimString(value || fallback).replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return normalized || '/';
}

function normalizePublicPaths(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const paths = [];
  for (const value of values) {
    const normalized = normalizePath(value, '/');
    if (!normalized || normalized === '/' || seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths.sort();
}

function buildSurfacePath(connectorId) {
  const normalizedConnectorId = trimString(connectorId).toLowerCase();
  if (!normalizedConnectorId) {
    throw new Error('connectorId is required');
  }
  return join(CONNECTOR_SURFACES_DIR, `${normalizedConnectorId}.json`);
}

function normalizeSurfaceRecord(record = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const connectorId = trimString(record.connectorId).toLowerCase();
  if (!connectorId) return null;
  const baseUrl = normalizeBaseUrl(record.baseUrl);
  if (!baseUrl) return null;
  return {
    connectorId,
    title: trimString(record.title) || connectorId,
    baseUrl,
    entryPath: normalizePath(record.entryPath || '/'),
    allowEmbed: record.allowEmbed !== false,
    publicPaths: normalizePublicPaths(record.publicPaths),
    updatedAt: trimString(record.updatedAt) || new Date().toISOString(),
  };
}

export function isConnectorSurfacePublicPath(surface, requestPath = '') {
  const normalizedPath = normalizePath(requestPath, '/');
  const publicPaths = normalizePublicPaths(surface?.publicPaths);
  if (!normalizedPath || publicPaths.length === 0) return false;
  return publicPaths.some((publicPath) => (
    normalizedPath === publicPath
    || normalizedPath.startsWith(`${publicPath}/`)
  ));
}

export async function registerConnectorSurface(record = {}) {
  const normalized = normalizeSurfaceRecord(record);
  if (!normalized) {
    throw new Error('connector surface requires connectorId and baseUrl');
  }
  await ensureDir(CONNECTOR_SURFACES_DIR);
  await writeJsonAtomic(buildSurfacePath(normalized.connectorId), normalized);
  return normalized;
}

export async function getConnectorSurface(connectorId) {
  const raw = await readJson(buildSurfacePath(connectorId), null);
  return normalizeSurfaceRecord(raw);
}

async function probeConnectorSurface(surface, { timeoutMs = 1000 } = {}) {
  if (!surface?.baseUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const probeUrl = new URL('/', `${surface.baseUrl}/`);
    const response = await fetch(probeUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'x-remotelab-surface-probe': '1',
      },
    });
    return !!response;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function getReachableConnectorSurface(connectorId, {
  clearStale = false,
  timeoutMs = 1000,
} = {}) {
  const surface = await getConnectorSurface(connectorId);
  if (!surface) return null;
  if (await probeConnectorSurface(surface, { timeoutMs })) {
    return surface;
  }
  if (clearStale) {
    await clearConnectorSurface(connectorId);
  }
  return null;
}

export async function listConnectorSurfaces() {
  let entries = [];
  try {
    entries = await readdir(CONNECTOR_SURFACES_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const surfaces = [];
  for (const entry of entries) {
    if (!entry?.isFile?.() || !entry.name.endsWith('.json')) continue;
    const connectorId = trimString(entry.name.slice(0, -5)).toLowerCase();
    if (!connectorId) continue;
    const surface = await getConnectorSurface(connectorId);
    if (surface) surfaces.push(surface);
  }
  return surfaces.sort((left, right) => left.connectorId.localeCompare(right.connectorId));
}

export async function listReachableConnectorSurfaces({
  clearStale = false,
  timeoutMs = 1000,
} = {}) {
  const surfaces = [];
  for (const surface of await listConnectorSurfaces()) {
    if (await probeConnectorSurface(surface, { timeoutMs })) {
      surfaces.push(surface);
      continue;
    }
    if (clearStale) {
      await clearConnectorSurface(surface.connectorId);
    }
  }
  return surfaces;
}

export async function clearConnectorSurface(connectorId) {
  await removePath(buildSurfacePath(connectorId));
}
