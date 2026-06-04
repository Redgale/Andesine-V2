/**
 * src/session.mjs
 *
 * Server-side session and cookie management.
 *
 * Each browser "session" gets its own CookieJar so that cookies set by
 * proxied sites are correctly stored and replayed on subsequent requests.
 *
 * Sessions are identified by a random ID that we either embed in the proxy
 * URL path segment or issue as a `_sjsid` response cookie.
 */

import { randomBytes } from 'crypto';

// Map<sessionId, CookieJar> — using the scramjet CookieJar so format is
// compatible when we serialize cookies back to the client.
const sessions = new Map();

/** Generate a short random session ID. */
export function makeId(len = 8) {
  return randomBytes(len).toString('base64url').slice(0, len);
}

/**
 * Look up a session by ID, creating one if it does not yet exist.
 *
 * The CookieJar is supplied lazily because it comes from the scramjet bundle
 * (loaded asynchronously at startup).
 */
export function getOrCreateSession(sessionId, CookieJar) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      cookieJar: new CookieJar(),
      createdAt: Date.now(),
    });
  }
  return sessions.get(sessionId);
}

/** Return an existing session or null. */
export function getSession(sessionId) {
  return sessions.get(sessionId) ?? null;
}

/**
 * Extract the session ID from an Express request.
 * Checks the `_sjsid` cookie first, falls back to generating a new one.
 */
export function resolveSessionId(req) {
  const raw = req.cookies?.['_sjsid'];
  if (raw && /^[A-Za-z0-9_-]{6,16}$/.test(raw)) return raw;
  return makeId();
}

/**
 * Apply `Set-Cookie` headers from the upstream response into the session's
 * cookie jar.
 *
 * @param {import('./session.mjs').Session} session
 * @param {URL} url  The URL that issued the cookies.
 * @param {Headers} responseHeaders  Upstream response headers.
 * @param {*} CookieJar  scramjet's CookieJar class.
 */
export function ingestSetCookie(session, url, responseHeaders) {
  const setCookieLines = responseHeaders.getSetCookie?.() ?? [];
  for (const line of setCookieLines) {
    try {
      session.cookieJar.setCookies(line, url);
    } catch {
      // malformed cookie — ignore
    }
  }
}

/**
 * Build a `Cookie: ...` request header string from the session jar.
 *
 * @param {*} session
 * @param {URL} url
 * @returns {string} Value for the Cookie header, or empty string.
 */
export function getCookieHeader(session, url) {
  try {
    return session.cookieJar.getCookies(url) ?? '';
  } catch {
    return '';
  }
}

/** Remove sessions older than `maxAgeMs` (default 2 hours). */
export function pruneSessions(maxAgeMs = 7_200_000) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
}

// Prune stale sessions every 30 minutes.
setInterval(pruneSessions, 30 * 60 * 1000).unref();
