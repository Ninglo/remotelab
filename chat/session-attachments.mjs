/**
 * Attachment processing: MIME detection, image resizing, save-to-disk.
 *
 * Extracted from session-manager.mjs — keeps identical signatures except
 * resizeImageIfNeeded is now async and uses a promise-based child process call.
 */

import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { extname, join } from 'path';
import { writeFile, readFile, stat } from 'fs/promises';
import { CHAT_IMAGES_DIR } from '../lib/config.mjs';
import { ensureDir, pathExists, statOrNull } from './fs-utils.mjs';

// ── MIME maps ────────────────────────────────────────────────────────

export const MIME_EXTENSIONS = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'video/mp4': '.mp4',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-m4v': '.m4v',
};

export const EXTENSION_MIME_TYPES = Object.fromEntries(
  Object.entries(MIME_EXTENSIONS).map(([mimeType, extension]) => [extension.slice(1), mimeType]),
);

// ── Helpers ──────────────────────────────────────────────────────────

export function sanitizeOriginalAttachmentName(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/\\/g, '/');
  const base = normalized.split('/').filter(Boolean).pop() || '';
  return base.replace(/\s+/g, ' ').slice(0, 255);
}

export function normalizeAttachmentSizeBytes(value) {
  const numeric = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export function resolveAttachmentMimeType(mimeType, originalName = '') {
  const normalizedMimeType = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (normalizedMimeType) {
    return normalizedMimeType;
  }
  const extension = extname(originalName || '').toLowerCase().replace(/^\./, '');
  return EXTENSION_MIME_TYPES[extension] || 'application/octet-stream';
}

export function resolveAttachmentExtension(mimeType, originalName = '') {
  const resolvedMimeType = resolveAttachmentMimeType(mimeType, originalName);
  if (MIME_EXTENSIONS[resolvedMimeType]) {
    return MIME_EXTENSIONS[resolvedMimeType];
  }
  const originalExtension = extname(originalName || '').toLowerCase();
  if (/^\.[a-z0-9]+$/.test(originalExtension)) {
    return originalExtension;
  }
  return '.bin';
}

// ── Image dimension constants & resize ───────────────────────────────

export const IMAGE_MAX_DIMENSION = 2000;
export const RESIZABLE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/tiff', 'image/bmp', 'image/gif']);

function execFilePromise(cmd, args, options) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function resizeImageIfNeeded(filepath, mimeType) {
  if (!RESIZABLE_MIME_TYPES.has(mimeType)) return false;
  try {
    const info = await execFilePromise('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filepath], { encoding: 'utf8', timeout: 10000 });
    const widthMatch = info.match(/pixelWidth:\s*(\d+)/);
    const heightMatch = info.match(/pixelHeight:\s*(\d+)/);
    if (!widthMatch || !heightMatch) return false;
    const width = Number(widthMatch[1]);
    const height = Number(heightMatch[1]);
    if (width <= IMAGE_MAX_DIMENSION && height <= IMAGE_MAX_DIMENSION) return false;
    if (width >= height) {
      await execFilePromise('sips', ['--resampleWidth', String(IMAGE_MAX_DIMENSION), filepath], { encoding: 'utf8', timeout: 30000 });
    } else {
      await execFilePromise('sips', ['--resampleHeight', String(IMAGE_MAX_DIMENSION), filepath], { encoding: 'utf8', timeout: 30000 });
    }
    return true;
  } catch {
    return false;
  }
}

// ── Save / resolve attachments ───────────────────────────────────────

export async function saveAttachments(images) {
  if (!images || images.length === 0) return [];
  await ensureDir(CHAT_IMAGES_DIR);
  return Promise.all(images.map(async (img) => {
    const originalName = sanitizeOriginalAttachmentName(img?.originalName || img?.name || '');
    const mimeType = resolveAttachmentMimeType(img?.mimeType, originalName);
    const ext = resolveAttachmentExtension(mimeType, originalName);
    const filename = randomBytes(12).toString('hex') + ext;
    const filepath = join(CHAT_IMAGES_DIR, filename);
    const fileBuffer = Buffer.isBuffer(img?.buffer)
      ? img.buffer
      : Buffer.from(typeof img?.data === 'string' ? img.data : '', 'base64');
    await writeFile(filepath, fileBuffer);
    const resized = await resizeImageIfNeeded(filepath, mimeType);
    const finalSize = resized ? (await stat(filepath)).size : fileBuffer.length;
    const finalData = resized && typeof img?.data === 'string'
      ? (await readFile(filepath)).toString('base64')
      : (typeof img?.data === 'string' ? img.data : undefined);
    return {
      filename,
      savedPath: filepath,
      ...(originalName ? { originalName } : {}),
      mimeType,
      ...(finalSize > 0 ? { sizeBytes: finalSize } : {}),
      ...(finalData ? { data: finalData } : {}),
    };
  }));
}

export async function resolveSavedAttachments(images) {
  const resolved = await Promise.all((images || []).map(async (image) => {
    const filename = typeof image?.filename === 'string' ? image.filename.trim() : '';
    if (!filename || !/^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(filename)) return null;
    const savedPath = join(CHAT_IMAGES_DIR, filename);
    if (!await pathExists(savedPath)) return null;
    const originalName = sanitizeOriginalAttachmentName(image?.originalName || '');
    const mimeType = resolveAttachmentMimeType(image?.mimeType, originalName || filename);
    const sizeBytes = normalizeAttachmentSizeBytes((await statOrNull(savedPath))?.size || image?.sizeBytes);
    return {
      filename,
      savedPath,
      ...(originalName ? { originalName } : {}),
      mimeType,
      ...(sizeBytes ? { sizeBytes } : {}),
    };
  }));
  return resolved.filter(Boolean);
}

export function buildMessageAttachmentRefs(images = []) {
  return (images || []).map((img) => ({
    ...(img.filename ? { filename: img.filename } : {}),
    ...(img.savedPath ? { savedPath: img.savedPath } : {}),
    ...(img.assetId ? { assetId: img.assetId } : {}),
    ...(img.originalName ? { originalName: img.originalName } : {}),
    mimeType: img.mimeType,
    ...(normalizeAttachmentSizeBytes(img?.sizeBytes) ? { sizeBytes: normalizeAttachmentSizeBytes(img.sizeBytes) } : {}),
    ...(trimString(img?.renderAs) === 'file' ? { renderAs: 'file' } : {}),
  }));
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
