const CACHE_NAME = 'yijian-gomoku-shell-v2';
const APP_SHELL = '/';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.add(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('yijian-gomoku-shell-') && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const savedPage = await cache.match(APP_SHELL);
    if (savedPage) return savedPage;
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(APP_SHELL, response.clone());
      return response;
    } catch {
      return new Response('此浏览器还没有缓存弈间页面。请在网络恢复后重新打开一次。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});

