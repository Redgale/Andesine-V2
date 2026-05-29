// Andesine — Service Worker (Classic Script)
//
// controller.sw.js is the scramjet-controller's compiled SW bundle.
// It sets the global $scramjetController with { shouldRoute, route }
// and registers its own install / activate / message listeners.
// All we need to add is the fetch handler.
//
// IMPORTANT: register this file WITHOUT { type: 'module' } so that
// importScripts() is available in the SW context.

importScripts('/controller/controller.sw.js');

self.addEventListener('fetch', (event) => {
  // $scramjetController.shouldRoute() returns true for any URL whose
  // pathname starts with a registered controller prefix.
  if ($scramjetController.shouldRoute(event)) {
    event.respondWith($scramjetController.route(event));
  }
});

// Note: install (skipWaiting) and activate (clients.claim) are already
// wired up inside controller.sw.js — no need to duplicate them here.
