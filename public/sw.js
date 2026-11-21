// Service worker: ทำให้แอปเปิดได้แม้ไม่มีอินเทอร์เน็ต
// - ไฟล์แอป: network-first (ได้เวอร์ชันใหม่เสมอเมื่อออนไลน์ ใช้แคชเมื่อออฟไลน์)
// - ไฟล์ไลบรารีใน vendor/ (มีเลขเวอร์ชันในชื่อโฟลเดอร์): cache-first

const VERSION = '1.0.0';
const SHELL_CACHE = `shell-${VERSION}`;
const VENDOR_CACHE = 'vendor';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/camera.js',
  'js/image-tools.js',
  'js/ocr.js',
  'js/store.js',
  'js/thai-text.js',
  'js/util.js',
  'js/video-scan.js',
  'js/word-export.js',
  'vendor/paths.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

async function pruneVendorCache() {
  try {
    const res = await fetch('vendor/paths.js', { cache: 'no-store' });
    const dirs = [...(await res.text()).matchAll(/"vendor\/([^/"]+)\//g)].map((m) => m[1]);
    if (!dirs.length) return;
    const cache = await caches.open(VENDOR_CACHE);
    for (const req of await cache.keys()) {
      const path = new URL(req.url).pathname;
      if (!dirs.some((d) => path.includes(`/vendor/${d}/`))) await cache.delete(req);
    }
  } catch {
    /* ออฟไลน์ — ไว้ลบครั้งหน้า */
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL_CACHE, VENDOR_CACHE];
      for (const key of await caches.keys()) {
        if (!keep.includes(key)) await caches.delete(key);
      }
      await pruneVendorCache();
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(VENDOR_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(request, { ignoreSearch: true })) ||
      (request.mode === 'navigate' ? await cache.match('index.html') : null);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const isVendorFile = url.pathname.includes('/vendor/') && !url.pathname.endsWith('/paths.js');
  event.respondWith(isVendorFile ? cacheFirst(request) : networkFirst(request));
});
