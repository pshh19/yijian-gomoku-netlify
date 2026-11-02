const CACHE_NAME = 'yijian-gomoku-shell-v6';
const APP_SHELL = '/';
const APP_FILES = ['/gomoku-ai.js', '/device-archive.js'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.add(APP_SHELL);
    await Promise.all(APP_FILES.map(file => cache.add(file).catch(() => {})));
  })());
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
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isPage = request.mode === 'navigate';
  const isAsset = APP_FILES.includes(url.pathname);
  if (!isPage && !isAsset) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const key = isPage ? APP_SHELL : url.pathname;
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (response.ok) await cache.put(key, response.clone());
      return response;
    } catch {
      const saved = await cache.match(key);
      if (saved) return saved;
      return new Response(isPage
        ? '此浏览器还没有缓存弈间页面。请在网络恢复后重新打开一次。'
        : 'AI 引擎暂时不可用，请联网后重试。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
