// 离线缓存：首次打开后无网络也能使用
const CACHE = 'miaobi-v1';
const FILES = ['./', './index.html', './css/style.css', './js/db.js', './js/geometry.js', './js/beautify.js',
  './js/render.js', './js/app.js', './manifest.webmanifest', './icon.svg', './icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 优先网络（方便更新），断网时用缓存
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
