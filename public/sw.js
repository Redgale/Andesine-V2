// Andesine — Scramjet v2 Service Worker
// Intercepts all fetch events and routes them through the Scramjet proxy engine

importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

// v2: loadConfig() is gone — config is managed by the controller at init time.
// The SW simply routes and fetches; no async config loading needed.
self.addEventListener("fetch", (event) => {
  if (scramjet.route(event)) {
    event.respondWith(scramjet.fetch(event));
  }
});

self.addEventListener("install", () => {
  // Force activate immediately so new SW takes over without waiting for tabs to close
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Claim all existing clients so the SW controls them without a page reload
  event.waitUntil(clients.claim());
});
