import { handleApi } from './engine.js';
import { browserStore } from './store.js';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname + 'v1/')) return;
  const path = '/' + url.pathname.slice(scope.pathname.length);
  event.respondWith(handleApi(event.request, path, browserStore));
});
