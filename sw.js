// Heebee Review Hub — Service Worker v1.0
// Strategy:
//   - App shell: network-first with cache fallback (always fresh when online)
//   - Google Fonts: stale-while-revalidate
//   - GAS API: network-only (never cache stale review data)
//   - Background Sync: queue failed POSTs, retry when back online
//   - Push: low-rated review notifications

const CACHE_VERSION = 'heebee-rev-v1.0';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// ── INSTALL ──────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // GAS API — never cache, always network
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleusercontent.com')) {
    return; // browser default
  }

  // Google Fonts — stale-while-revalidate
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    e.respondWith(
      caches.open(CACHE_VERSION).then(async cache => {
        const cached = await cache.match(e.request);
        const fetched = fetch(e.request).then(res => {
          if (res && res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => cached);
        return cached || fetched;
      })
    );
    return;
  }

  // App shell — network-first, cache fallback
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── BACKGROUND SYNC ──────────────────────────────────
// Queued replies/updates that failed while offline
self.addEventListener('sync', e => {
  if (e.tag === 'flush-review-queue') {
    e.waitUntil(flushQueue());
  }
});

async function flushQueue() {
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'FLUSH_QUEUE' }));
}

// ── PUSH NOTIFICATIONS ───────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(
    self.registration.showNotification(data.title || 'New review', {
      body: data.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: data.tag || 'review',
      data: data.url || './index.html',
      vibrate: [80, 40, 80]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data || './index.html'));
});

// ── MESSAGE HANDLERS ─────────────────────────────────
self.addEventListener('message', e => {
  if (!e.data) return;

  // Update app badge with unread count
  if (e.data.type === 'SET_BADGE' && 'setAppBadge' in self.registration) {
    const n = e.data.count || 0;
    if (n > 0) self.registration.setAppBadge(n);
    else self.registration.clearAppBadge();
  }

  // Skip waiting on demand (for forced updates)
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
