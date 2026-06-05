/**
 * src/proxy.mjs  (revised)
 *
 * Key changes from the original:
 *
 *  1. Replaced $scramjet.rewriteHtml / rewriteJs / rewriteCss / rewriteUrl
 *     with the local rewriter.mjs module.
 *
 *     The original code called those functions directly off $scramjet, but
 *     dist/scramjet.js is the *client* IIFE bundle — it exposes ScramjetClient,
 *     setWasm, CookieJar, etc., NOT standalone rewriting helpers.  Every call
 *     threw TypeError, the catch block returned raw HTML, and the browser
 *     resolved relative URLs (/_next/static/…) against the proxy origin →
 *     404s returning HTML → MIME-type mismatch errors in the console.
 *
 *  2. The inject-script snippet now uses a plain <script> block for the init
 *     payload instead of a data:-URI <script src=...>.  Browsers block
 *     data:-sourced scripts in many contexts.
 *
 *  3. CSS is actively rewritten (url() references).
 *
 *  4. JS is served as-is from the upstream.  Dynamic requests (fetch, XHR,
 *     WebSocket) are handled at runtime by ScramjetClient.hook() if the client
 *     bootstrap succeeds.  Full static JS rewriting would require a proper
 *     AST rewriter (the WASM one); that can be re-enabled once the $scramjet
 *     server API surface is confirmed.
 */

import { getScramjet } from './loader.mjs';
import {
  getOrCreateSession,
  ingestSetCookie,
  getCookieHeader,
} from './session.mjs';
import {
  rewriteHtmlAttributes,
  rewriteCssUrls,
  buildInjectSnippet,
  rewriteOneUrl,
} from './rewriter.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROXY_PREFIX = '/~/sj/';

const VIRTUAL_WASM_PATH = 'scramjet.wasm.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
]);

const STRIP_REQUEST_HEADERS = new Set([
  'host', 'origin', 'referer', 'x-forwarded-for', 'via',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseProxyPath(pathname) {
  if (!pathname.startsWith(PROXY_PREFIX)) return null;

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

function decodeProxyUrl(encodedUrl) {
  try {
    return decodeURIComponent(encodedUrl);
  } catch {
    return null;
  }
}

export function buildPrefixUrl(req, sessionId, frameId) {
  const proto =
    req.headers['x-forwarded-proto'] ??
    (req.socket?.encrypted ? 'https' : 'http');
  const host =
    req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  return new URL(`${proto}://${host}${PROXY_PREFIX}${sessionId}/${frameId}/`);
}

/**
 * Rewrite a redirect Location header through the proxy.
 * Uses our own rewriteOneUrl rather than $scramjet.rewriteUrl.
 */
function rewriteLocationHeader(location, realRequestUrl, prefixUrl) {
  if (!location) return null;
  try {
    const absolute = new URL(location, realRequestUrl).href;
    return rewriteOneUrl(absolute, realRequestUrl, prefixUrl.href);
  } catch {
    return location;
  }
}

// ---------------------------------------------------------------------------
// Main proxy handler
// ---------------------------------------------------------------------------

export function createProxyHandler(config, sjconfig) {
  // We no longer call getScramjet().rewriteHtml etc. — those don't exist on
  // the browser bundle.  We keep getScramjet() available in case future work
  // adds WASM-backed JS rewriting via the correct API.
  let sj;
  try {
    sj = getScramjet();
  } catch {
    sj = null;
  }

  if (sj) {
    const available = Object.keys(sj).filter(k => typeof sj[k] === 'function');
    console.log('[proxy] $scramjet functions available:', available.join(', ') || '(none)');
  }

  return async function proxyHandler(req, res) {
    // ------------------------------------------------------------------
    // 1. Parse the proxy URL.
    // ------------------------------------------------------------------
    const fullPath = req.originalUrl.split('?')[0];
    const parsed = parseProxyPath(fullPath);

    if (!parsed) {
      return res.status(400).send('Invalid proxy path');
    }

    const { sessionId, frameId, encodedUrl } = parsed;

    // ------------------------------------------------------------------
    // 2. Virtual WASM loader.
    // ------------------------------------------------------------------
    if (encodedUrl === VIRTUAL_WASM_PATH) {
      return serveVirtualWasm(res);
    }

    const realUrlStr = decodeProxyUrl(encodedUrl);
    if (realUrlStr === VIRTUAL_WASM_PATH) {
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

    if (realUrl.protocol !== 'http:' && realUrl.protocol !== 'https:') {
      return res.status(400).send('Only http/https URLs are supported');
    }

    // ------------------------------------------------------------------
    // 3. Session + prefix.
    // ------------------------------------------------------------------
    const { CookieJar } = sj ?? { CookieJar: null };
    const session = getOrCreateSession(sessionId, CookieJar);
    const prefixUrl = buildPrefixUrl(req, sessionId, frameId);

    // ------------------------------------------------------------------
    // 4. Build upstream request headers.
    // ------------------------------------------------------------------
    const upstreamHeaders = new Headers();
    upstreamHeaders.set('User-Agent', DEFAULT_UA);
    upstreamHeaders.set('Accept', req.headers.accept ?? '*/*');
    upstreamHeaders.set(
      'Accept-Language',
      req.headers['accept-language'] ?? 'en-US,en;q=0.9'
    );
    // Disable compression — we need to rewrite plain text.
    upstreamHeaders.set('Accept-Encoding', 'identity');

    const PASSTHROUGH = [
      'if-modified-since', 'if-none-match', 'cache-control', 'range',
    ];
    for (const h of PASSTHROUGH) {
      if (req.headers[h]) upstreamHeaders.set(h, req.headers[h]);
    }

    const cookieHeader = getCookieHeader(session, realUrl);
    if (cookieHeader) upstreamHeaders.set('Cookie', cookieHeader);

    // Un-proxify the Referer header.
    const rawReferer = req.headers.referer ?? req.headers.referrer;
    if (rawReferer) {
      try {
        const refUrl = new URL(rawReferer);
        if (refUrl.pathname.startsWith(PROXY_PREFIX)) {
          const refParsed = parseProxyPath(refUrl.pathname);
          if (refParsed) {
            const realRef = decodeProxyUrl(refParsed.encodedUrl);
            if (realRef) upstreamHeaders.set('Referer', realRef);
          }
        }
      } catch { /* ignore */ }
    }

    if (req.headers.origin) {
      upstreamHeaders.set('Origin', realUrl.origin);
    }

    let body = null;
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      body = await readBody(req);
      if (req.headers['content-type']) {
        upstreamHeaders.set('Content-Type', req.headers['content-type']);
      }
    }

    // ------------------------------------------------------------------
    // 5. Fetch upstream.
    // ------------------------------------------------------------------
    let upstream;
    try {
      upstream = await fetch(realUrl.href, {
        method: req.method,
        headers: upstreamHeaders,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      console.error(`[proxy] fetch error for ${realUrl.href}:`, err.message);
      return res.status(502).send(`Upstream fetch failed: ${err.message}`);
    }

    // ------------------------------------------------------------------
    // 6. Persist cookies.
    // ------------------------------------------------------------------
    ingestSetCookie(session, realUrl, upstream.headers);

    const setCookieLines = upstream.headers.getSetCookie?.() ?? [];
    for (const line of setCookieLines) {
      res.append('Set-Cookie', sanitizeSetCookie(line));
    }

    // ------------------------------------------------------------------
    // 7. Redirects.
    // ------------------------------------------------------------------
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get('location');
      if (loc) {
        res.setHeader(
          'Location',
          rewriteLocationHeader(loc, realUrl.href, prefixUrl)
        );
      }
      return res.status(upstream.status).end();
    }

    // ------------------------------------------------------------------
    // 8. Response headers.
    // ------------------------------------------------------------------
    for (const [key, value] of upstream.headers) {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    res.removeHeader('X-Frame-Options');

    // ------------------------------------------------------------------
    // 9. Rewrite body.
    // ------------------------------------------------------------------
    const ct = upstream.headers.get('content-type') ?? '';

    if (/^text\/html/i.test(ct)) {
      await handleHtml(res, upstream, realUrl, prefixUrl, session, config, sjconfig);
    } else if (/^text\/css/i.test(ct)) {
      await handleCss(res, upstream, realUrl, prefixUrl);
    } else if (/^(application\/(javascript|x-javascript|ecmascript)|text\/(javascript|ecmascript))/i.test(ct)) {
      // Pass JS through unchanged; ScramjetClient.hook() handles dynamic
      // runtime requests.  Full static JS rewriting needs the WASM API
      // (future work once the correct $scramjet server interface is found).
      res.status(upstream.status);
      res.setHeader('Content-Type', 'application/javascript');
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } else {
      res.status(upstream.status);
      res.send(Buffer.from(await upstream.arrayBuffer()));
    }
  };

  // -----------------------------------------------------------------------
  // HTML handler
  // -----------------------------------------------------------------------
  async function handleHtml(res, upstream, realUrl, prefixUrl, session, config, sjconfig) {
    const html = await upstream.text();

    const injectSnippet = buildInjectSnippet(
      prefixUrl,
      config,
      session,
      sjconfig ?? (sj?.defaultConfig ?? null)
    );

    let rewritten;
    try {
      rewritten = rewriteHtmlAttributes(html, realUrl, prefixUrl, injectSnippet);
    } catch (err) {
      console.error('[proxy] rewriteHtmlAttributes error:', err.message);
      rewritten = html;
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(rewritten);
  }

  // -----------------------------------------------------------------------
  // CSS handler
  // -----------------------------------------------------------------------
  async function handleCss(res, upstream, realUrl, prefixUrl) {
    const css = await upstream.text();

    let rewritten;
    try {
      rewritten = rewriteCssUrls(css, realUrl.href, prefixUrl.href);
    } catch (err) {
      console.error('[proxy] rewriteCssUrls error:', err.message);
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
// Utilities
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sanitizeSetCookie(line) {
  return line
    .replace(/;\s*domain=[^;]*/gi, '')
    .replace(/;\s*samesite=none/gi, '')
    .replace(/__Host-/gi, '_proxy_host_')
    .replace(/__Secure-/gi, '_proxy_sec_');
}
