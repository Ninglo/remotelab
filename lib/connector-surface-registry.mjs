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
    updatedAt: trimString(record.updatedAt) || new Date().toISOString(),
  };
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

export async function clearConnectorSurface(connectorId) {
  await removePath(buildSurfacePath(connectorId));
}
