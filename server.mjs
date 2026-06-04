/**
 * server.mjs — Andesine proxy server
 *
 * Ties together:
 *  - Express HTTP server
 *  - src/proxy.mjs   → handles /~/sj/… proxy requests
 *  - src/wisp.mjs    → handles /~/wisp WebSocket (Wisp v1)
 *  - src/session.mjs → per-browser cookie jar management
 *  - src/loader.mjs  → loads scramjet.js + WASM server-side
 *  - public/         → Andesine frontend + client inject script
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { loadScramjet } from './src/loader.mjs';
import { createProxyHandler, PROXY_PREFIX } from './src/proxy.mjs';
import { resolveSessionId, makeId } from './src/session.mjs';
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
  app.use(cookieParser());

  // ── Static assets ──────────────────────────────────────────────────────

  // Serve the scramjet bundle at a stable URL
  app.get('/scramjet.js', (_req, res) => {
    res.sendFile(resolve(__dirname, 'dist', 'scramjet.js'));
  });

  // Serve everything in public/ (frontend + no-sw-inject.js)
  app.use(express.static(resolve(__dirname, 'public')));

  // ── Session management ─────────────────────────────────────────────────

  /**
   * GET /~/session
   * Ensures the browser has a valid _sjsid cookie and returns the session ID.
   * Call this once on page load so subsequent /~/go requests include the cookie.
   */
  app.get('/~/session', (req, res) => {
    let sid = req.cookies?.['_sjsid'];
    if (!sid || !/^[A-Za-z0-9_-]{6,16}$/.test(sid)) {
      sid = makeId();
    }
    res.cookie('_sjsid', sid, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7_200_000, // 2 hours
    });
    res.json({ sessionId: sid });
  });

  // ── Navigation entry point ─────────────────────────────────────────────

  /**
   * GET /~/go?url=<target>
   * Redirects the browser into the proxy for the given URL.
   * Creates or re-uses the session from the cookie.
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
      // Try prepending https:// and see if it parses
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
    let sid = req.cookies?.['_sjsid'];
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

  // ── HTTP + WebSocket server ────────────────────────────────────────────

  const httpServer = createServer(app);

  // Wisp WebSocket server for multiplexed TCP (used by scramjet's WS transport)
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', handleWispConnection);

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url === '/~/wisp' || req.url?.startsWith('/~/wisp/')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`[andesine] Listening on http://${HOST}:${PORT}`);
  });

  // Graceful shutdown
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`[andesine] ${sig} received — shutting down`);
      httpServer.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('[andesine] Fatal startup error:', err);
  process.exit(1);
});
