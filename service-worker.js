'use strict';
/*
 * Service Worker конкурса «Лазурный берег».
 * Оболочка приложения кэшируется при установке; /api/* всегда идёт в сеть.
 * Офлайн-очередь оценок хранится в IndexedDB и отправляется из app.js.
 */
const CACHE_NAME = 'lazurny-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/shared/scoring.js',
  '/client/api.js',
  '/client/idb.js',
  '/manifest.json',
  '/assets/noroot.png',
  '/assets/background.jpg',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[sw] precache', err))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API не кэшируем: состояние и оценки всегда свежие с сервера.
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/index.html', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {});
        }
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
