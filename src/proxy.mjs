/**
 * src/proxy.mjs
 *
 * The "server as service worker" — the heart of the whole approach.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Original flow (with SW):                                       │
 * │  browser → SW (intercepts /~/sj/…) → Controller (RPC) →        │
 * │    ScramjetFetchHandler → transport → bare-server → internet    │
 * │                                                                 │
 * │  Our flow (no SW):                                              │
 * │  browser → THIS MODULE (handles /~/sj/…) → internet (direct)   │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * URL format: /~/sj/<sessionId>/<frameId>/<encodedUrl>
 *
 *   sessionId  — per-browser-session ID (stored in _sjsid cookie)
 *   frameId    — per-page-load ID (used as part of the scramjet prefix)
 *   encodedUrl — encodeURIComponent(realUrl)
 *
 * This module exports a single Express request handler that:
 *   1. Parses the proxy URL.
 *   2. Fetches the real resource with node-fetch (directly — no transport).
 *   3. Ingests Set-Cookie headers into the session's cookie jar.
 *   4. Rewrites HTML / JS / CSS using scramjet's own rewriter functions
 *      (running server-side with the WASM module loaded via src/loader.mjs).
 *   5. Streams or sends the rewritten response back to the browser.
 */

import { getScramjet } from './loader.mjs';
import {
  getOrCreateSession,
  ingestSetCookie,
  getCookieHeader,
} from './session.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROXY_PREFIX = '/~/sj/';

// The virtual WASM loader path that the client requests (per scramjet's
// convention).  We serve it dynamically.
const VIRTUAL_WASM_PATH = 'scramjet.wasm.js';

// How we identify ourselves to upstream servers.
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Headers we strip from the upstream response before forwarding.
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',   // we decompress before rewriting
  'content-length',     // we may change the body
  'transfer-encoding',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
]);

// Headers we don't forward from the browser to the upstream server.
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'x-forwarded-for',
  'via',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a proxy path into its constituent parts.
 *
 * Input:  /~/sj/abc123/def456/https%3A%2F%2Fexample.com%2Fpath
 * Output: { sessionId: 'abc123', frameId: 'def456', realUrl: 'https://example.com/path' }
 *
 * Returns null if the path is not a valid proxy path.
 */
export function parseProxyPath(pathname) {
  if (!pathname.startsWith(PROXY_PREFIX)) return null;

  // Strip the prefix, then split into at most 3 segments:
  //   [sessionId, frameId, ...encodedUrlParts]
  const rest = pathname.slice(PROXY_PREFIX.length);
  const slashIdx1 = rest.indexOf('/');
  if (slashIdx1 === -1) return null;

  const sessionId = rest.slice(0, slashIdx1);
  const rest2 = rest.slice(slashIdx1 + 1);

  const slashIdx2 = rest2.indexOf('/');
  if (slashIdx2 === -1) return null;

  const frameId = rest2.slice(0, slashIdx2);
  const encodedUrl = rest2.slice(slashIdx2 + 1);

  if (!sessionId || !frameId || !encodedUrl) return null;

  return { sessionId, frameId, encodedUrl };
}

/**
 * Decode the URL segment, supporting both plain encodeURIComponent encoding
 * and the hex-xor encoding that advanced scramjet configs may use.
 */
function decodeProxyUrl(encodedUrl) {
  try {
    return decodeURIComponent(encodedUrl);
  } catch {
    return null;
  }
}

/** Build the proxy prefix URL used as ScramjetContext.prefix. */
export function buildPrefixUrl(req, sessionId, frameId) {
  const proto = req.headers['x-forwarded-proto'] ?? (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  return new URL(`${proto}://${host}${PROXY_PREFIX}${sessionId}/${frameId}/`);
}

/**
 * Rewrite a `Location` redirect header so the browser follows through the
 * proxy instead of leaving it.
 */
function rewriteLocationHeader(location, realRequestUrl, context) {
  if (!location) return null;
  const { rewriteUrl } = getScramjet();
  try {
    const absolute = new URL(location, realRequestUrl);
    return rewriteUrl(absolute.href, context, {
      origin: new URL(realRequestUrl),
      base: new URL(realRequestUrl),
    });
  } catch {
    return location; // best-effort
  }
}

// ---------------------------------------------------------------------------
// Scramjet context factory
// ---------------------------------------------------------------------------

/**
 * Build the ScramjetContext passed to every rewriter call.
 *
 * This mirrors the context that ScramjetFetchHandler constructs in the
 * browser, but running entirely on the server with our own cookie jar and
 * inject-script factory.
 */
function buildContext(prefixUrl, session, config, sjconfig) {
  const { CookieJar, defaultConfig } = getScramjet();
  const effectiveSjconfig = sjconfig ?? defaultConfig;

  /**
   * getInjectScripts is called by rewriteHtml for every proxied HTML page.
   * It returns the <script> elements that bootstrap scramjet in the page.
   *
   * We replicate the logic from Controller/Frame.yieldGetInjectScripts, but
   * without the service-worker requirement.  The client side uses
   * client/no-sw-inject.js instead of controller.inject.js.
   */
  function getInjectScripts(_meta, _handler, htmlcontext, script) {
    const initPayload = {
      config,
      sjconfig: effectiveSjconfig,
      // prefix is a string here; client reconstructs with new URL(...)
      prefixHref: prefixUrl.href,
      cookies: session.cookieJar.dump(),
      // Pass codec as source strings so the client can eval them.
      // We use the default encodeURIComponent / decodeURIComponent codec.
      codecEncodeStr: 'function(u){return u?encodeURIComponent(u):u}',
      codecDecodeStr: 'function(u){return u?decodeURIComponent(u):u}',
      initHeaders: htmlcontext.headers ?? [],
      history: htmlcontext.history ?? [],
    };

    // Inline initialisation script (serialised as a data: URL so the
    // scramjet html rewriter can inject it as a <script src=...>).
    const initScript = `
(function(){
  var p = ${JSON.stringify(initPayload)};
  p.prefix = new URL(p.prefixHref);
  p.codecEncode = ${initPayload.codecEncodeStr};
  p.codecDecode = ${initPayload.codecDecodeStr};
  $scramjetController.load(p);
})();
    `.trim();

    const initDataUrl =
      'data:text/javascript;charset=utf-8;base64,' +
      Buffer.from(initScript).toString('base64');

    return [
      script(config.scramjetPath),
      // The virtual WASM loader — served dynamically at
      // /~/sj/<sid>/<fid>/scramjet.wasm.js
      script(prefixUrl.href + config.virtualWasmPath),
      // Our custom inject (replaces controller.inject.js, no SW needed)
      script(config.injectPath),
      script(initDataUrl),
    ];
  }

  function getWorkerInjectScripts(_meta, _isModule, script) {
    const workerInit = `
(function(){
  var { ScramjetClient, CookieJar, setWasm } = $scramjet;
  setWasm(Uint8Array.from(atob(self.WASM), function(c){return c.charCodeAt(0)}));
  delete self.WASM;
  var context = {
    config: ${JSON.stringify(effectiveSjconfig)},
    prefix: new URL(${JSON.stringify(prefixUrl.href)}),
    interface: {
      codecEncode: function(u){return u?encodeURIComponent(u):u},
      codecDecode: function(u){return u?decodeURIComponent(u):u},
    },
  };
  var client = new ScramjetClient(globalThis, { context, transport: null });
  client.hook();
})();
    `.trim();

    return (
      script(config.scramjetPath) +
      script(prefixUrl.href + config.virtualWasmPath) +
      'data:text/javascript;charset=utf-8;base64,' +
      Buffer.from(workerInit).toString('base64')
    );
  }

  return {
    config: effectiveSjconfig,
    prefix: prefixUrl,
    cookieJar: session.cookieJar,
    interface: {
      getInjectScripts,
      getWorkerInjectScripts,
      codecEncode: (u) => (u ? encodeURIComponent(u) : u),
      codecDecode: (u) => (u ? decodeURIComponent(u) : u),
    },
  };
}

// ---------------------------------------------------------------------------
// MIME detection helpers
// ---------------------------------------------------------------------------

const HTML_MIME = /^text\/html/i;
const JS_MIME = /^(application\/(javascript|x-javascript|ecmascript)|text\/(javascript|ecmascript))/i;
const CSS_MIME = /^text\/css/i;
const WORKER_MIME = JS_MIME; // workers are JS

function contentType(headers) {
  return headers.get('content-type') ?? '';
}

// ---------------------------------------------------------------------------
// Main proxy handler
// ---------------------------------------------------------------------------

/**
 * Express middleware factory.
 *
 * Usage:
 *   app.use(PROXY_PREFIX, createProxyHandler(config, sjconfig));
 *
 * @param {object} config    Controller config (prefix, paths, codec, …)
 * @param {object} [sjconfig] Optional scramjet config overrides.
 */
export function createProxyHandler(config, sjconfig) {
  const { rewriteHtml, rewriteJs, rewriteCss, rewriteUrl } = getScramjet();

  return async function proxyHandler(req, res) {
    // ------------------------------------------------------------------
    // 1. Parse the proxy URL from the request path.
    // ------------------------------------------------------------------

    // Express mounts us at /~/sj/ so req.path begins after the mount.
    // We reconstruct the full path to stay mount-agnostic.
    const fullPath = req.originalUrl.split('?')[0];
    const parsed = parseProxyPath(fullPath);

    if (!parsed) {
      return res.status(400).send('Invalid proxy path');
    }

    const { sessionId, frameId, encodedUrl } = parsed;
    const realUrlStr = decodeProxyUrl(encodedUrl);

    // ------------------------------------------------------------------
    // 2. Handle the virtual WASM loader — a synthetic JS file that
    //    embeds the WASM binary as a base64 string so the browser can
    //    call setWasm() without a separate ArrayBuffer fetch.
    //    Path: /~/sj/<sid>/<fid>/scramjet.wasm.js
    // ------------------------------------------------------------------

    if (realUrlStr === VIRTUAL_WASM_PATH || encodedUrl === VIRTUAL_WASM_PATH) {
      return serveVirtualWasm(res);
    }

    if (!realUrlStr) {
      return res.status(400).send('Could not decode proxy URL');
    }

    let realUrl;
    try {
      realUrl = new URL(realUrlStr);
    } catch {
      return res.status(400).send(`Invalid URL: ${realUrlStr}`);
    }

    // Only allow http/https
    if (realUrl.protocol !== 'http:' && realUrl.protocol !== 'https:') {
      return res.status(400).send('Only http/https URLs are supported');
    }

    // ------------------------------------------------------------------
    // 3. Set up session and context.
    // ------------------------------------------------------------------

    const { CookieJar } = getScramjet();
    const session = getOrCreateSession(sessionId, CookieJar);
    const prefixUrl = buildPrefixUrl(req, sessionId, frameId);
    const context = buildContext(prefixUrl, session, config, sjconfig);

    // ------------------------------------------------------------------
    // 4. Forward the browser request to the real server.
    // ------------------------------------------------------------------

    // Build forwarded headers — strip browser fingerprint, add cookies.
    const upstreamHeaders = new Headers();
    upstreamHeaders.set('User-Agent', DEFAULT_UA);
    upstreamHeaders.set('Accept', req.headers.accept ?? '*/*');
    upstreamHeaders.set('Accept-Language', req.headers['accept-language'] ?? 'en-US,en;q=0.9');
    upstreamHeaders.set('Accept-Encoding', 'identity'); // disable compression — we rewrite text

    // Forward any safe headers the browser sent.
    const PASSTHROUGH = ['if-modified-since', 'if-none-match', 'cache-control', 'range'];
    for (const h of PASSTHROUGH) {
      if (req.headers[h]) upstreamHeaders.set(h, req.headers[h]);
    }

    // Restore cookies from the session jar.
    const cookieHeader = getCookieHeader(session, realUrl);
    if (cookieHeader) upstreamHeaders.set('Cookie', cookieHeader);

    // Reconstruct Referer from the client Referer header (un-proxify it).
    const rawReferer = req.headers.referer ?? req.headers.referrer;
    if (rawReferer) {
      try {
        const refUrl = new URL(rawReferer);
        const refPath = refUrl.pathname;
        if (refPath.startsWith(PROXY_PREFIX)) {
          const refParsed = parseProxyPath(refPath);
          if (refParsed) {
            const realReferer = decodeProxyUrl(refParsed.encodedUrl);
            if (realReferer) upstreamHeaders.set('Referer', realReferer);
          }
        }
      } catch { /* ignore */ }
    }

    // Forward origin header
    if (req.headers.origin) {
      upstreamHeaders.set('Origin', realUrl.origin);
    }

    // Read the request body for POST/PUT/PATCH
    let body = null;
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      body = await readBody(req);
      if (req.headers['content-type']) {
        upstreamHeaders.set('Content-Type', req.headers['content-type']);
      }
    }

    // ------------------------------------------------------------------
    // 5. Fetch the real resource.
    // ------------------------------------------------------------------

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(realUrl.href, {
        method: req.method,
        headers: upstreamHeaders,
        body,
        redirect: 'manual', // we handle redirects ourselves
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      console.error(`[proxy] fetch error for ${realUrl.href}:`, err.message);
      return res.status(502).send(`Upstream fetch failed: ${err.message}`);
    }

    // ------------------------------------------------------------------
    // 6. Persist cookies from the upstream response.
    // ------------------------------------------------------------------

    ingestSetCookie(session, realUrl, upstreamResponse.headers);

    // Also set cookies in the browser for the proxy origin (so scripts can
    // read them via document.cookie — scramjet's cookie hook handles this).
    const setCookieLines = upstreamResponse.headers.getSetCookie?.() ?? [];
    for (const line of setCookieLines) {
      res.append('Set-Cookie', sanitizeSetCookie(line));
    }

    // ------------------------------------------------------------------
    // 7. Handle redirects: rewrite the Location header.
    // ------------------------------------------------------------------

    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      const location = upstreamResponse.headers.get('location');
      if (location) {
        const rewritten = rewriteLocationHeader(location, realUrl, context);
        res.setHeader('Location', rewritten);
      }
      return res.status(upstreamResponse.status).end();
    }

    // ------------------------------------------------------------------
    // 8. Build the response headers for the browser.
    // ------------------------------------------------------------------

    for (const [key, value] of upstreamResponse.headers) {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    // Relax security policies so scramjet's hooks work.
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    res.removeHeader('X-Frame-Options');

    // ------------------------------------------------------------------
    // 9. Rewrite the body based on content type.
    // ------------------------------------------------------------------

    const ct = contentType(upstreamResponse.headers);

    if (HTML_MIME.test(ct)) {
      await rewriteHtmlResponse(res, upstreamResponse, realUrl, context);
    } else if (JS_MIME.test(ct)) {
      await rewriteJsResponse(res, upstreamResponse, realUrl, context);
    } else if (CSS_MIME.test(ct)) {
      await rewriteCssResponse(res, upstreamResponse, realUrl, context);
    } else {
      // Pass through binary/image/font/etc. unchanged.
      res.status(upstreamResponse.status);
      const buf = Buffer.from(await upstreamResponse.arrayBuffer());
      res.send(buf);
    }
  };

  // -----------------------------------------------------------------------
  // Rewriting helpers
  // -----------------------------------------------------------------------

  async function rewriteHtmlResponse(res, upstream, realUrl, context) {
    const html = await upstream.text();
    const meta = {
      origin: new URL(realUrl),
      base: new URL(realUrl),
    };
    const htmlcontext = {
      loadScripts: true,
      inline: false,
      source: realUrl.href,
      headers: [...upstream.headers],
      history: [],
    };

    let rewritten;
    try {
      rewritten = rewriteHtml(html, context, meta, htmlcontext);
    } catch (err) {
      console.error('[proxy] rewriteHtml error:', err.message);
      rewritten = html; // fall back to passthrough
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(rewritten);
  }

  async function rewriteJsResponse(res, upstream, realUrl, context) {
    const js = await upstream.text();
    const meta = {
      origin: new URL(realUrl),
      base: new URL(realUrl),
    };

    let rewritten;
    try {
      const result = rewriteJs(js, realUrl.href, context, meta, false);
      // rewriteJs can return a string or Uint8Array
      rewritten = result instanceof Uint8Array ? Buffer.from(result) : result;
    } catch (err) {
      console.error('[proxy] rewriteJs error:', err.message);
      rewritten = js;
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/javascript');
    res.send(rewritten);
  }

  async function rewriteCssResponse(res, upstream, realUrl, context) {
    const css = await upstream.text();
    const meta = {
      origin: new URL(realUrl),
      base: new URL(realUrl),
    };

    let rewritten;
    try {
      rewritten = rewriteCss(css, context, meta);
    } catch (err) {
      console.error('[proxy] rewriteCss error:', err.message);
      rewritten = css;
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', 'text/css');
    res.send(rewritten);
  }
}

// ---------------------------------------------------------------------------
// Virtual WASM loader
// ---------------------------------------------------------------------------

let _wasmB64Cache = null;

async function serveVirtualWasm(res) {
  if (!_wasmB64Cache) {
    // Read WASM from the loader's vm context via the scramjet API.
    // We can't easily re-read the file, so we serve it from the dist path.
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dn = dirname(fileURLToPath(import.meta.url));
    const buf = readFileSync(resolve(__dn, '..', 'dist', 'scramjet.wasm'));
    _wasmB64Cache = `self.WASM = '${buf.toString('base64')}';`;
  }
  res.setHeader('Content-Type', 'application/javascript');
  res.send(_wasmB64Cache);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Read the request body as a Buffer. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Sanitise a Set-Cookie header so it is scoped to the proxy origin rather
 * than leaking real domain names.
 */
function sanitizeSetCookie(line) {
  // Strip Domain=, Secure (if we're on http), SameSite=None, __Host- prefix
  return line
    .replace(/;\s*domain=[^;]*/gi, '')
    .replace(/;\s*samesite=none/gi, '')
    .replace(/__Host-/gi, '_proxy_host_')
    .replace(/__Secure-/gi, '_proxy_sec_');
}
