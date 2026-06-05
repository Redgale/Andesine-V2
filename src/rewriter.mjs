/**
 * src/rewriter.mjs
 *
 * Self-contained server-side HTML and CSS URL rewriter.
 *
 * Why this exists:
 *   proxy.mjs originally called $scramjet.rewriteHtml / rewriteJs / rewriteCss,
 *   but dist/scramjet.js is the *browser* IIFE bundle, not the server npm
 *   package.  The browser bundle exposes ScramjetClient, setWasm, CookieJar —
 *   NOT standalone rewriting functions.  Every call threw a TypeError that the
 *   catch block silently swallowed, falling back to raw HTML.  That meant every
 *   relative URL (/_next/static/…, /assets/…, etc.) resolved against the proxy
 *   origin rather than the real site → 404 returning HTML → MIME-type mismatch.
 *
 * This module provides:
 *   rewriteHtmlAttributes(html, realUrl, prefixUrl, injectSnippet)
 *   rewriteCssUrls(css, realUrl, prefixUrl)
 *   rewriteOneUrl(rawUrl, base, prefix)
 */

// ---------------------------------------------------------------------------
// Core URL rewriting
// ---------------------------------------------------------------------------

/**
 * Turn a single raw URL (possibly relative) into a proxy URL.
 *
 * Leaves data:, blob:, #, javascript:, mailto:, tel: as-is.
 * Only proxies http / https.
 */
export function rewriteOneUrl(rawUrl, base, prefix) {
  if (!rawUrl) return rawUrl;
  const trimmed = rawUrl.trim();
  if (
    !trimmed ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('about:')
  ) {
    return rawUrl;
  }
  try {
    const abs = new URL(trimmed, base).href;
    if (abs.startsWith('http:') || abs.startsWith('https:')) {
      return prefix + encodeURIComponent(abs);
    }
  } catch { /* malformed URL — leave alone */ }
  return rawUrl;
}

/**
 * Rewrite a `srcset` attribute value, e.g.
 *   "img-320.png 320w, img-640.png 640w"
 */
function rewriteSrcset(srcset, base, prefix) {
  return srcset.split(',').map(part => {
    const trimmed = part.trim();
    const spaceIdx = trimmed.search(/\s/);
    if (spaceIdx === -1) {
      return rewriteOneUrl(trimmed, base, prefix);
    }
    const url = trimmed.slice(0, spaceIdx);
    const descriptor = trimmed.slice(spaceIdx); // " 320w" or " 2x" etc.
    return rewriteOneUrl(url, base, prefix) + descriptor;
  }).join(', ');
}

// ---------------------------------------------------------------------------
// HTML rewriting
// ---------------------------------------------------------------------------

// Attributes that contain a single URL.
const URL_ATTRS = new Set([
  'src', 'href', 'action', 'data', 'poster', 'manifest',
  'formaction', 'ping', 'cite', 'background',
]);

/**
 * Simple but robust HTML attribute rewriter based on a character-level scan.
 *
 * We do NOT use a full DOM parser (no external deps needed) but we do handle
 * quoted and unquoted attributes correctly, plus special cases.
 *
 * @param {string} html           Raw HTML from the upstream server.
 * @param {URL}    realUrl        The URL of the upstream resource.
 * @param {URL}    prefixUrl      Our proxy prefix URL object.
 * @param {string} [injectSnippet]  HTML to inject just before </head>
 *                                  (the scramjet bootstrap <script> tags).
 * @returns {string}  Rewritten HTML.
 */
export function rewriteHtmlAttributes(html, realUrl, prefixUrl, injectSnippet) {
  const base = realUrl.href;
  const prefix = prefixUrl.href;

  // -- 1. Strip <base> tags (we've already resolved everything relative) ----
  html = html.replace(/<base\b[^>]*/gi, '<base');

  // -- 2. Remove CSP / X-Frame-Options meta tags ---------------------------
  //    These would block the scramjet scripts we inject.
  html = html.replace(
    /<meta[^>]+http-equiv\s*=\s*["']?\s*content-security-policy\s*["']?[^>]*>/gi,
    ''
  );
  html = html.replace(
    /<meta[^>]+http-equiv\s*=\s*["']?\s*x-frame-options\s*["']?[^>]*>/gi,
    ''
  );

  // -- 3. Rewrite attribute values -----------------------------------------
  //    We scan for attr="value", attr='value', attr=value patterns.
  html = rewriteTagAttributes(html, base, prefix);

  // -- 4. Rewrite inline style url() references ----------------------------
  html = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (m, open, css, close) => open + rewriteCssUrls(css, base, prefix) + close
  );

  // -- 5. Inject bootstrap scripts -----------------------------------------
  if (injectSnippet) {
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, injectSnippet + '</head>');
    } else if (/<body[\s>]/i.test(html)) {
      html = html.replace(/<body([\s>])/i, injectSnippet + '<body$1');
    } else {
      html = injectSnippet + html;
    }
  }

  return html;
}

/**
 * Walk every tag in the HTML and rewrite URL-bearing attributes.
 * Handles double-quoted, single-quoted, and unquoted attribute values.
 */
function rewriteTagAttributes(html, base, prefix) {
  // Match opening tags (not closing tags, not comments, not doctype).
  // We use a two-phase approach: find each opening tag, then scan its attrs.
  return html.replace(
    /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g,
    (match, tagName, attrStr) => {
      if (!attrStr) return match;

      // Special-case: skip <script type="application/ld+json"> etc., but still
      // rewrite script src.

      const rewritten = attrStr.replace(
        /(\s)([\w-]+)\s*=\s*(?:"([^"]*)"|(\'[^\']*\')|((?:[^\s"'>]|&amp;)+))/g,
        (am, space, attrName, dqVal, sqVal, uqVal) => {
          const attrLower = attrName.toLowerCase();
          let val = dqVal ?? (sqVal ? sqVal.slice(1, -1) : uqVal ?? '');
          let quote = dqVal !== undefined ? '"' : sqVal ? "'" : '';

          if (attrLower === 'srcset') {
            const rw = rewriteSrcset(val, base, prefix);
            return `${space}${attrName}=${quote}${rw}${quote}`;
          }

          if (URL_ATTRS.has(attrLower)) {
            const rw = rewriteOneUrl(val, base, prefix);
            return `${space}${attrName}=${quote}${rw}${quote}`;
          }

          // style attribute may contain url()
          if (attrLower === 'style' && val.includes('url(')) {
            const rw = rewriteCssUrls(val, base, prefix);
            return `${space}${attrName}=${quote}${rw}${quote}`;
          }

          return am; // unchanged
        }
      );

      return `<${tagName}${rewritten}>`;
    }
  );
}

// ---------------------------------------------------------------------------
// CSS rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite url() references in CSS / style blocks / inline styles.
 *
 * @param {string} css
 * @param {string} base   Absolute URL of the CSS resource (for relative refs).
 * @param {string} prefix Proxy prefix string.
 * @returns {string}
 */
export function rewriteCssUrls(css, base, prefix) {
  // url("..."), url('...'), url(...)
  return css.replace(
    /url\(\s*(?:"([^"]*)"|(\'[^\']*\')|([^)\s]*))\s*\)/gi,
    (match, dq, sq, bare) => {
      const raw = dq ?? (sq ? sq.slice(1, -1) : bare ?? '');
      const rw = rewriteOneUrl(raw, base, prefix);
      if (dq !== undefined) return `url("${rw}")`;
      if (sq) return `url('${rw}')`;
      return `url(${rw})`;
    }
  );
}

// ---------------------------------------------------------------------------
// Inject-snippet builder
// ---------------------------------------------------------------------------

/**
 * Build the <script> tags that bootstrap scramjet in the proxied page.
 *
 * Replaces the data:-URI approach from proxy.mjs (data: script sources are
 * blocked by many CSPs and in some browser modes).  Instead, the init payload
 * is inlined as a tiny <script> block.
 *
 * @param {URL}    prefixUrl
 * @param {object} config      Server config (scramjetPath, injectPath, …)
 * @param {object} session     Session object (has .cookieJar)
 * @param {object} [sjconfig]  Scramjet internal config (or null)
 * @returns {string}  HTML snippet ready to inject into <head>.
 */
export function buildInjectSnippet(prefixUrl, config, session, sjconfig) {
  const initPayload = {
    sjconfig: sjconfig ?? {},
    prefixHref: prefixUrl.href,
    cookies: session?.cookieJar?.dump?.() ?? [],
    codecEncodeStr: 'function(u){return u?encodeURIComponent(u):u}',
    codecDecodeStr: 'function(u){return u?decodeURIComponent(u):u}',
  };

  // Inline init script — avoids data: src issues entirely.
  const initScript = `
(function(){
  var p = ${JSON.stringify(initPayload)};
  p.prefix = new URL(p.prefixHref);
  p.codecEncode = ${initPayload.codecEncodeStr};
  p.codecDecode = ${initPayload.codecDecodeStr};
  if(window.$scramjetController) $scramjetController.load(p);
})();
  `.trim();

  const scramjetSrc = config.scramjetPath;
  const wasmSrc = prefixUrl.href + (config.virtualWasmPath ?? 'scramjet.wasm.js');
  const injectSrc = config.injectPath;

  return [
    `<script src="${scramjetSrc}"></script>`,
    `<script src="${wasmSrc}"></script>`,
    `<script src="${injectSrc}"></script>`,
    `<script>${initScript}</script>`,
  ].join('\n');
}
