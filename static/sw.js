'use strict';

async function clearLegacyCaches() {
  const cacheNames = await self.caches.keys();
  await Promise.all(cacheNames
    .filter((name) => name !== 'remotelab-share-target')
    .map((cacheName) => self.caches.delete(cacheName)));
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(clearLegacyCaches());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await clearLegacyCaches();
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.disable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'remotelab:clear-caches') return;
  event.waitUntil(clearLegacyCaches());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const target = {
    sessionId: data.sessionId || null,
    tab: data.tab || 'sessions',
    url: data.url || '/',
  };

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Skip notification if app window is currently visible
      for (const client of clientList) {
        if (client.visibilityState === 'visible') return;
      }
      return self.registration.showNotification(data.title || 'RemoteLab', {
        body: data.body || 'Task completed',
        icon: '/icon.svg',
        badge: '/apple-touch-icon.png',
        tag: 'remotelab-done',
        renotify: true,
        data: target,
      });
    })
  );
});

// ---- Share Target handling ----
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.endsWith('/share-receive') && event.request.method === 'POST') {
    event.respondWith(handleShareTarget(event.request));
  }
});

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const shareData = {
      title: formData.get('title') || '',
      text: formData.get('text') || '',
      url: formData.get('url') || '',
      files: [],
      timestamp: Date.now(),
    };

    // Cache shared files as separate entries
    const cache = await caches.open('remotelab-share-target');
    const mediaFiles = formData.getAll('media');
    for (let i = 0; i < mediaFiles.length; i++) {
      const file = mediaFiles[i];
      if (!file || typeof file.arrayBuffer !== 'function') continue;
      const buffer = await file.arrayBuffer();
      const cacheKey = `/share-target-file-${i}`;
      shareData.files.push({
        name: file.name || `shared-${i}`,
        type: file.type || 'application/octet-stream',
        size: file.size || buffer.byteLength,
        cacheKey,
      });
      await cache.put(cacheKey, new Response(buffer, {
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      }));
    }

    await cache.put('/share-target-data', new Response(JSON.stringify(shareData), {
      headers: { 'Content-Type': 'application/json' },
    }));
    // Use SW scope to redirect to the correct base path (handles proxy prefixes)
    const scopePath = new URL(self.registration.scope).pathname;
    const clientUrl = new URL(scopePath, request.url);
    clientUrl.searchParams.set('share', '1');
    return Response.redirect(clientUrl.href, 303);
  } catch {
    const scopePath = new URL(self.registration.scope).pathname;
    return Response.redirect(new URL(scopePath, request.url).href, 303);
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = {
    sessionId: event.notification.data?.sessionId || null,
    tab: event.notification.data?.tab || 'sessions',
    url: event.notification.data?.url || '/',
  };
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const client = clientList[0];
      if (client) {
        client.postMessage({
          type: 'remotelab:open-session',
          sessionId: target.sessionId,
          tab: target.tab,
          url: target.url,
        });
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target.url);
    })
  );
});
