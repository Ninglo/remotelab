import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PROMPT_ASSET_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'prompt-assets');
const assetCache = new Map();
const assetLoadPromises = new Map();

function normalizePromptAssetPath(relativePath) {
  const normalized = typeof relativePath === 'string'
    ? relativePath.replace(/^\/+/, '').trim()
    : '';
  return normalized;
}

export async function readPromptAsset(relativePath) {
  const normalized = normalizePromptAssetPath(relativePath);
  if (!normalized) return '';
  if (assetCache.has(normalized)) {
    return assetCache.get(normalized);
  }
  if (assetLoadPromises.has(normalized)) {
    return assetLoadPromises.get(normalized);
  }

  const loadPromise = readFile(join(PROMPT_ASSET_ROOT, normalized), 'utf8')
    .then((content) => {
      assetCache.set(normalized, content);
      assetLoadPromises.delete(normalized);
      return content;
    })
    .catch((error) => {
      assetLoadPromises.delete(normalized);
      throw error;
    });

  assetLoadPromises.set(normalized, loadPromise);
  return loadPromise;
}

export function renderPromptTemplate(template, values = {}) {
  return String(template || '').replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
    const value = values[key];
    return value == null ? '' : String(value);
  });
}

export async function renderPromptAsset(relativePath, values = {}) {
  return renderPromptTemplate(await readPromptAsset(relativePath), values);
}
