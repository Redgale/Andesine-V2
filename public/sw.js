// Andesine — Scramjet v2 Service Worker (ES Module)
// importScripts() + $scramjetLoadWorker() were removed in v2.
// The SW is now a standard ES module; register it with { type: 'module' }.

import { ScramjetServiceWorker } from '/scram/scramjet.mjs';

const scramjet = new ScramjetServiceWorker();

self.addEventListener('fetch', (event) => {
  if (scramjet.route(event)) {
    event.respondWith(scramjet.fetch(event));
  }
});

self.addEventListener('install', () => {
  // Force activate immediately — no waiting for existing tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim all existing clients so the new SW takes effect without a reload.
  event.waitUntil(clients.claim());
});
