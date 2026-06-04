/**
 * server.mjs — Andesine proxy server
 *
 * Ties together:
 *  - Express HTTP server (with express-ws for WebSocket support)
 *  - src/proxy.mjs   → handles /~/sj/… proxy requests
 *  - src/wisp.mjs    → handles /~/wisp WebSocket (Wisp v1)
 *  - src/session.mjs → per-browser cookie jar management
 *  - src/loader.mjs  → loads scramjet.js + WASM server-side
 *  - public/         → Andesine frontend + client inject script
 */

import express from 'express';
import expressWs from 'express-ws';
import { parse as parseCookies } from 'cookie';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { loadScramjet } from './src/loader.mjs';
import { createProxyHandler, PROXY_PREFIX } from './src/proxy.mjs';
import { makeId } from './src/session.mjs';
import { handleWispConnection } from './src/wisp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ---------------------------------------------------------------------------
// Controller config — URL paths the browser client needs to load
// ---------------------------------------------------------------------------

const config = {
  // Path where we serve the scramjet bundle (dist/scramjet.js)
  scramjetPath: '/scramjet.js',

  // Path relative to the proxy prefix served as a virtual JS file embedding
  // the WASM binary as base64. Handled internally by proxy.mjs.
  virtualWasmPath: 'scramjet.wasm.js',

  // Our custom client-side inject (no service worker required)
  injectPath: '/no-sw-inject.js',
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  console.log('[andesine] Starting up…');
  console.log('[andesine] Loading scramjet WASM (this may take a moment)…');
  await loadScramjet();
  console.log('[andesine] Scramjet ready ✓');

  const app = express();

  // Attach express-ws so app.ws() is available and upgrades are handled
  const { getWss } = expressWs(app);

  // ── Cookie parsing middleware (uses 'cookie' package, no cookie-parser) ──
  app.use((req, _res, next) => {
    req.cookies = parseCookies(req.headers.cookie || '');
    next();
  });

  // ── Static assets ──────────────────────────────────────────────────────

  // Serve the scramjet bundle at a stable URL
  app.get('/scramjet.js', (_req, res) => {
    res.sendFile(resolve(__dirname, 'dist', 'scramjet.js'));
  });

  // Serve everything in public/ (frontend + no-sw-inject.js)
  app.use(express.static(resolve(__dirname, 'public')));

  // ── Wisp WebSocket ─────────────────────────────────────────────────────

  // express-ws makes app.ws() available; routes are matched like HTTP routes
  app.ws('/~/wisp', (ws, _req) => {
    handleWispConnection(ws);
  });

  // Also handle /~/wisp/ with trailing slash or sub-paths
  app.ws('/~/wisp/*', (ws, _req) => {
    handleWispConnection(ws);
  });

  // ── Session management ─────────────────────────────────────────────────

  /**
   * GET /~/session
   * Ensures the browser has a valid _sjsid cookie and returns the session ID.
   */
  app.get('/~/session', (req, res) => {
    let sid = req.cookies['_sjsid'];
    if (!sid || !/^[A-Za-z0-9_-]{6,16}$/.test(sid)) {
      sid = makeId();
    }
    res.cookie('_sjsid', sid, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7_200_000, // 2 hours in ms
    });
    res.json({ sessionId: sid });
  });

  // ── Navigation entry point ─────────────────────────────────────────────

  /**
   * GET /~/go?url=<target>
   * Redirects the browser into the proxy for the given URL.
   */
  app.get('/~/go', (req, res) => {
    const target = req.query.url;
    if (!target) {
      return res.status(400).send('Missing ?url= parameter');
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(target);
    } catch {
      try {
        parsedTarget = new URL('https://' + target);
      } catch {
        return res.status(400).send('Invalid URL');
      }
    }

    if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
      return res.status(400).send('Only http/https URLs are supported');
    }

    // Issue or reuse session cookie
    let sid = req.cookies['_sjsid'];
    if (!sid || !/^[A-Za-z0-9_-]{6,16}$/.test(sid)) {
      sid = makeId();
      res.cookie('_sjsid', sid, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7_200_000,
      });
    }

    const fid = makeId(8);
    const proxyUrl = `${PROXY_PREFIX}${sid}/${fid}/${encodeURIComponent(parsedTarget.href)}`;
    res.redirect(302, proxyUrl);
  });

  // ── Proxy handler ──────────────────────────────────────────────────────

  app.use(PROXY_PREFIX, createProxyHandler(config));

  // ── Health check ───────────────────────────────────────────────────────

  app.get('/~/health', (_req, res) => {
    res.json({ status: 'ok', service: 'andesine' });
  });

  // ── Start listening ────────────────────────────────────────────────────

  app.listen(PORT, HOST, () => {
    console.log(`[andesine] Listening on http://${HOST}:${PORT}`);
  });

  // Graceful shutdown
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`[andesine] ${sig} received — shutting down`);
      getWss().close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('[andesine] Fatal startup error:', err);
  process.exit(1);
});
