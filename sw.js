/* NEXUS Hub service worker: app shell offline + app icons. Live data (weather, headlines) is fetched by
   the page and its last copy kept in the page's own storage, so offline shows the last stats. */
const VERSION = 'nxhub-v5';
const SHELL = ['./', './index.html', './style.css', './controls.js', './app.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/favicon-32.png', './icons/apple-touch-icon.png'];
const APP_ICONS = ['/Bibley-/icons/icon-192.png', '/3tbwg/icons/icon-192.png', '/NEXUS-Calendar/icons/icon-192.png',
  '/NEXUS-News/icons/icon-192.png', '/Ultimate-Weather/icons/icon-192.png', '/Apologetics101/icons/icon-192.png',
  '/NEXUS-Alarm/icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    // Other apps' icons: best effort, one missing icon must not block install.
    await Promise.all(APP_ICONS.map(u => fetch(u, { cache: 'reload' }).then(r => r.ok && c.put(u, r)).catch(() => {})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('nxhub-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // weather + news APIs go straight to the network
  const scope = new URL(self.registration.scope).pathname;
  if (req.mode === 'navigate') {
    if (!url.pathname.startsWith(scope)) return;
    // network first so updates show up; fall back to the cached shell offline
    e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(VERSION).then(c => c.put('./index.html', cp)); } return r; })
      .catch(async () => (await caches.match('./index.html')) || (await caches.match('./')) || Response.error()));
    return;
  }
  const isIcon = APP_ICONS.includes(url.pathname);
  if (!url.pathname.startsWith(scope) && !isIcon) return;
  // stale-while-revalidate for the shell and icons
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(isIcon ? url.pathname : req, { ignoreSearch: true });
    const net = fetch(req).then(r => { if (r.ok) c.put(isIcon ? url.pathname : req, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || Response.error();
  }));
});
