import { canReadSession } from './session-access.mjs';
import webpush from 'web-push';
import { dirname } from 'path';
import { VAPID_KEYS_FILE, PUSH_SUBSCRIPTIONS_FILE } from '../lib/config.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { createSerialTaskQueue, ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';

let ready = false;
let initPromise = null;
let cachedKeys = null;
const PUSH_TIMEOUT_MS = Number.parseInt(process.env.PUSH_TIMEOUT_MS || '5000', 10);
const PUSH_NETWORK_FAILURE_THRESHOLD = Number.parseInt(process.env.PUSH_NETWORK_FAILURE_THRESHOLD || '3', 10);
const PUSH_NETWORK_BACKOFF_MS = Number.parseInt(process.env.PUSH_NETWORK_BACKOFF_MS || `${30 * 60 * 1000}`, 10);
const runSubscriptionMutation = createSerialTaskQueue();
const pushTransportEnv = buildToolProcessEnv();

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function resolvePushSendOptions(env = pushTransportEnv) {
  const options = { timeout: PUSH_TIMEOUT_MS };
  const proxy = firstNonEmpty(
    env?.REMOTELAB_PUSH_PROXY,
    env?.HTTPS_PROXY,
    env?.https_proxy,
    env?.HTTP_PROXY,
    env?.http_proxy,
  );
  if (proxy) options.proxy = proxy;
  return options;
}

async function loadOrGenerateKeys() {
  if (cachedKeys) return cachedKeys;
  const existing = await readJson(VAPID_KEYS_FILE, null);
  if (existing) {
    cachedKeys = existing;
    return cachedKeys;
  }
  cachedKeys = webpush.generateVAPIDKeys();
  await ensureDir(dirname(VAPID_KEYS_FILE));
  await writeJsonAtomic(VAPID_KEYS_FILE, cachedKeys);
  console.log('[push] Generated new VAPID keys');
  return cachedKeys;
}

async function init() {
  if (ready) return;
  if (!initPromise) {
    initPromise = (async () => {
      const keys = await loadOrGenerateKeys();
      webpush.setVapidDetails('mailto:remotelab@localhost', keys.publicKey, keys.privateKey);
      ready = true;
    })();
  }
  await initPromise;
}

function buildMeta(meta = {}) {
  return {
    failureCount: Number.isFinite(meta.failureCount) ? meta.failureCount : 0,
    disabledUntil: Number.isFinite(meta.disabledUntil) ? meta.disabledUntil : 0,
    lastError: typeof meta.lastError === 'string' ? meta.lastError : '',
  };
}

function withFreshMeta(sub) {
  return { ...sub, __meta: buildMeta() };
}

function normalizeSubs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.endpoint === 'string')
    .map((entry) => ({ ...entry, __meta: buildMeta(entry.__meta) }));
}

function isInBackoff(sub) {
  return sub?.__meta?.disabledUntil > Date.now();
}

function clearNetworkFailure(sub) {
  return withFreshMeta(sub);
}

function isNetworkFailure(err) {
  const code = `${err?.code || ''}`.toUpperCase();
  if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPROTO'].includes(code)) {
    return true;
  }
  const message = `${err?.message || ''}`.toLowerCase();
  return [
    'socket timeout',
    'timed out',
    'tls',
    'client network socket disconnected',
    'econnreset',
    'eai_again',
    'unexpected response code',
  ].some((fragment) => message.includes(fragment));
}

function recordNetworkFailure(sub, err) {
  const failureCount = (sub?.__meta?.failureCount || 0) + 1;
  const disabledUntil = failureCount >= PUSH_NETWORK_FAILURE_THRESHOLD
    ? Date.now() + PUSH_NETWORK_BACKOFF_MS
    : 0;
  return {
    ...sub,
    __meta: {
      failureCount,
      disabledUntil,
      lastError: `${err?.message || 'network_error'}`,
    },
  };
}

export async function getPublicKey() {
  await init();
  return cachedKeys.publicKey;
}

async function loadSubs() {
  return normalizeSubs(await readJson(PUSH_SUBSCRIPTIONS_FILE, []));
}

async function saveSubs(subs) {
  await ensureDir(dirname(PUSH_SUBSCRIPTIONS_FILE));
  await writeJsonAtomic(PUSH_SUBSCRIPTIONS_FILE, subs);
}

export async function addSubscription(sub) {
  await init();
  await runSubscriptionMutation(async () => {
    const subs = await loadSubs();
    const idx = subs.findIndex((entry) => entry.endpoint === sub.endpoint);
    const next = withFreshMeta(sub);
    if (idx >= 0) subs[idx] = next;
    else subs.push(next);
    await saveSubs(subs);
    console.log(`[push] Subscription saved (total: ${subs.length})`);
  });
}

function buildSessionUrl(session) {
  const params = new URLSearchParams();
  if (session?.id) params.set('session', session.id);
  params.set('tab', 'sessions');
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

export async function sendCompletionPush(session) {
  await init();
  const subs = await loadSubs();
  if (subs.length === 0) return;

  const activeCount = subs.filter((sub) => !isInBackoff(sub)).length;
  if (activeCount === 0) return;

  const folder = (session?.folder || '').split('/').pop() || 'Session';
  const name = session?.name || folder;
  const payload = JSON.stringify({
    title: 'RemoteLab',
    body: `${name} — task completed`,
    sessionId: session?.id || null,
    tab: 'sessions',
    url: buildSessionUrl(session),
  });

  const stale = new Set();
  let changed = false;
  const nextSubs = [...subs];
  await Promise.allSettled(subs.map(async (sub, i) => {
    if (isInBackoff(sub) || !canReadSession({ personId: sub.personId }, session)) return;
    try {
      await webpush.sendNotification(sub, payload, resolvePushSendOptions());
      if ((sub?.__meta?.failureCount || 0) > 0 || (sub?.__meta?.disabledUntil || 0) > 0 || sub?.__meta?.lastError) {
        nextSubs[i] = clearNetworkFailure(sub);
        changed = true;
      }
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) stale.add(i);
      else if (isNetworkFailure(err)) {
        nextSubs[i] = recordNetworkFailure(sub, err);
        changed = true;
        const meta = nextSubs[i].__meta;
        if (meta.disabledUntil > 0) {
          console.warn(`[push] Backing off subscription for ${Math.round(PUSH_NETWORK_BACKOFF_MS / 60000)}m after ${meta.failureCount} network failures: ${err.message}`);
        } else {
          console.warn(`[push] Send failed (${meta.failureCount}/${PUSH_NETWORK_FAILURE_THRESHOLD}): ${err.message}`);
        }
      } else {
        console.warn(`[push] Send failed: ${err.message}`);
      }
    }
  }));

  if (changed || stale.size > 0) {
    await runSubscriptionMutation(async () => {
      await saveSubs(nextSubs.filter((_, i) => !stale.has(i)));
    });
  }

  if (stale.size > 0) {
    console.log(`[push] Removed ${stale.size} stale subscription(s)`);
  }
}
