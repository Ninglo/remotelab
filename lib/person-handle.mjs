import { createHash } from 'crypto';

import { pinyin } from 'pinyin-pro';

const MAX_HANDLE_LENGTH = 48;
const MAX_HANDLE_BASE_LENGTH = 36;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizePersonHandle(value) {
  return trimString(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_HANDLE_LENGTH)
    .replace(/-+$/g, '');
}

export function derivePersonHandleBase(...values) {
  for (const value of values) {
    const normalized = trimString(value);
    if (!normalized) continue;
    const transliterated = pinyin(normalized, {
      toneType: 'none',
      type: 'array',
    }).join('');
    const handle = normalizePersonHandle(transliterated || normalized)
      .slice(0, MAX_HANDLE_BASE_LENGTH)
      .replace(/-+$/g, '');
    if (handle) return handle;
  }
  return 'person';
}

export function buildStablePersonHandle({ displayName = '', englishName = '', seed = '' } = {}) {
  const base = derivePersonHandleBase(englishName, displayName);
  const suffix = createHash('sha256')
    .update(trimString(seed) || `${englishName}\u0000${displayName}`)
    .digest('hex')
    .slice(0, 4);
  return `${base.slice(0, MAX_HANDLE_LENGTH - suffix.length - 1)}-${suffix}`;
}

export function personHandleMatchesBase(handle, base) {
  const normalizedHandle = normalizePersonHandle(handle);
  const normalizedBase = normalizePersonHandle(base);
  return Boolean(
    normalizedHandle
    && normalizedBase
    && (
      normalizedHandle === normalizedBase
      || normalizedHandle.startsWith(`${normalizedBase}-`)
      || new RegExp(`^${normalizedBase}[0-9]{2,6}$`).test(normalizedHandle)
    )
  );
}
