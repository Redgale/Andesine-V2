/**
 * public/no-sw-inject.js
 *
 * Client-side scramjet initialiser — service-worker-free edition.
 *
 * The server injects this script (along with scramjet.js and the WASM loader)
 * into every proxied HTML page via getInjectScripts().
 *
 * Responsibilities:
 *  1. Expose window.$scramjetController with a load(payload) method so the
 *     init data-URL script (injected right after us) can call it.
 *  2. Inside load():
 *     a. Wait for scramjet.js to have run ($scramjet global is ready).
 *     b. Feed the WASM binary to $scramjet.setWasm().
 *     c. Instantiate ScramjetClient and call .hook() to patch window APIs
 *        (fetch, XHR, WebSocket, location, document.cookie, …) so that
 *        dynamically-constructed URLs are rewritten through the proxy prefix
 *        — the same rewriting the server already did statically for all
 *        HTML / JS / CSS bodies.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Tiny retry helper — polls until condition() is true, then calls fn().
  // -------------------------------------------------------------------------
  function waitFor(condition, fn, intervalMs, timeoutMs) {
    intervalMs = intervalMs || 20;
    timeoutMs  = timeoutMs  || 5000;
    var elapsed = 0;
    var id = setInterval(function () {
      elapsed += intervalMs;
      if (condition()) {
        clearInterval(id);
        fn();
      } else if (elapsed >= timeoutMs) {
        clearInterval(id);
        console.warn('[andesine] waitFor: timed out after', timeoutMs, 'ms');
      }
    }, intervalMs);
  }

  // -------------------------------------------------------------------------
  // $scramjetController — the interface the init data-URL script calls.
  // -------------------------------------------------------------------------
  window.$scramjetController = {
    /**
     * load(p) — called by the inline init script injected by the server.
     *
     * @param {object} p
     * @param {object} p.sjconfig      Scramjet internal config
     * @param {URL}    p.prefix        Proxy prefix URL object
     * @param {string} p.prefixHref    Proxy prefix as href string
     * @param {Function} p.codecEncode URL encoder (encodeURIComponent)
     * @param {Function} p.codecDecode URL decoder (decodeURIComponent)
     */
    load: function (p) {
      // scramjet.js evaluates synchronously before this script in page order,
      // but use a poll just in case the browser yields between the two scripts.
      waitFor(
        function () { return typeof window.$scramjet !== 'undefined'; },
        function () { bootClient(p); },
        20,
        8000
      );
    },
  };

  // -------------------------------------------------------------------------
  // bootClient — runs once $scramjet is confirmed to be on the window.
  // -------------------------------------------------------------------------
  function bootClient(p) {
    var sj = window.$scramjet;

    // -- 1. WASM initialisation -----------------------------------------------
    // The virtual WASM loader (served by the proxy at <prefix>scramjet.wasm.js)
    // sets self.WASM = '<base64-encoded wasm binary>' before this runs.
    if (typeof window.WASM === 'string' && window.WASM.length > 0) {
      try {
        var bytes = Uint8Array.from(atob(window.WASM), function (c) {
          return c.charCodeAt(0);
        });
        sj.setWasm(bytes);
      } catch (e) {
        console.warn('[andesine] WASM init failed:', e.message);
      }
      // Delete so it's not sitting in memory / accessible to page scripts.
      try { delete window.WASM; } catch (_) { window.WASM = undefined; }
    }

    // -- 2. ScramjetClient context -------------------------------------------
    // Mirror what ScramjetFetchHandler builds in the SW version, but without
    // any service-worker transport.  In no-SW mode all static HTML/JS/CSS is
    // already rewritten by the server; ScramjetClient hooks are only needed
    // for *dynamic* requests constructed at runtime (e.g. fetch("https://…")
    // called from page script).  The hooks rewrite those URLs into proxy URLs
    // and call native fetch directly — no SW intercept needed.
    var context = {
      config: p.sjconfig || {},
      prefix: p.prefix,
      interface: {
        codecEncode: p.codecEncode || function (u) { return u ? encodeURIComponent(u) : u; },
        codecDecode: p.codecDecode || function (u) { return u ? decodeURIComponent(u) : u; },
      },
    };

    // -- 3. Hook ---------------------------------------------------------------
    if (typeof sj.ScramjetClient === 'function') {
      try {
        var client = new sj.ScramjetClient(window, {
          context: context,
          // transport: null — the proxy hooks rewrite URLs to the proxy prefix
          // so native fetch/XHR can reach them directly.
          transport: null,
        });
        client.hook();
        console.debug('[andesine] ScramjetClient hooked (no-SW mode) ✓');
      } catch (e) {
        console.warn('[andesine] ScramjetClient.hook() failed:', e.message);
        // Non-fatal: static rewrites still work; only dynamic requests break.
      }
    } else {
      // Older scramjet builds may not expose ScramjetClient at $scramjet.
      // Log but do not crash — server-side rewrites cover most sites.
      console.warn('[andesine] $scramjet.ScramjetClient not found — dynamic-request hooking disabled');
    }
  }
})();
