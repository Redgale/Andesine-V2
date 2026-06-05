/**
 * src/loader.mjs
 *
 * Bootstraps scramjet.js inside a Node.js vm.Context.
 *
 * Problem: scramjet.js is an IIFE browser bundle that reads global browser
 * symbols (WebSocket, Response, ReadableStream, …) when it first executes.
 * We cannot import it as an ES module on the server, but we CAN evaluate it
 * inside a vm context where every required global is either native (Node ≥18)
 * or shimmed.
 *
 * After this module resolves you get back a populated `$scramjet` object
 * with the rewriter functions and a ready WASM instance.
 */

import vm from 'vm';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');

// ---------------------------------------------------------------------------
// Browser shims required by the scramjet bundle at evaluation time.
// Only the bits the bundle actually touches at class-definition time are
// needed here — we don't need full implementations.
// ---------------------------------------------------------------------------

/** Minimal WebSocket constants (accessed at class-definition time). */
const WebSocketStub = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
};

/** Minimal window.location lookalike so URL-dependent code doesn't crash. */
const locationStub = new URL('http://localhost:8080/');

/**
 * Build a vm context that has every global scramjet.js needs.
 * Node 18+ provides Response, ReadableStream, fetch, TextEncoder, URL, …
 * natively on globalThis, so we spread those in and only shim the rest.
 */
function buildContext() {
  const ctx = Object.create(null);

  // --- Standard web globals available natively in Node 18+ ---
  const nativeGlobals = [
    'Response', 'Request', 'Headers', 'fetch',
    'ReadableStream', 'WritableStream', 'TransformStream',
    'TextEncoder', 'TextDecoder',
    'URL', 'URLSearchParams',
    'EventTarget', 'Event', 'CustomEvent',
    'BroadcastChannel',
    'MessageChannel', 'MessagePort',
    'AbortController', 'AbortSignal',
    'Blob', 'File', 'FormData',
    'WebAssembly',
    'crypto',
    'atob', 'btoa',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'queueMicrotask',
    'console',
    'Buffer',
    'process',
  ];

  for (const name of nativeGlobals) {
    if (name in globalThis) {
      ctx[name] = globalThis[name];
    }
  }

  // --- Shims ---
  ctx.WebSocket = WebSocketStub;
  ctx.location = locationStub;

  // `self` and `globalThis` point at the context itself
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.global = ctx;

  // performance.now() — used by the scramjet profiling/timing utilities
  ctx.performance = globalThis.performance ?? { now: () => Date.now() };

  // URL.createObjectURL / revokeObjectURL — used by blob rewriting
  if (!globalThis.URL.createObjectURL) {
    globalThis.URL.createObjectURL = () => 'blob:not-supported';
    globalThis.URL.revokeObjectURL = () => {};
  }
  ctx.URL = globalThis.URL;

  // Minimal navigator so navigator.serviceWorker references don't throw
  ctx.navigator = {
    serviceWorker: null,
    userAgent: 'Mozilla/5.0 (compatible; ScramjetServer/1.0)',
  };

  // indexedDB stub — only the Controller class uses it, not the rewriters
  ctx.indexedDB = {
    open: () => {
      const req = {};
      Promise.resolve().then(() => req.onerror?.('indexedDB not available in server context'));
      return req;
    },
  };

  // Symbol is available on ctx via the vm default prototype chain, but make
  // it explicit for safety.
  ctx.Symbol = Symbol;
  ctx.Promise = Promise;
  ctx.Array = Array;
  ctx.Object = Object;
  ctx.Error = Error;
  ctx.TypeError = TypeError;
  ctx.Map = Map;
  ctx.Set = Set;
  ctx.WeakMap = WeakMap;
  ctx.WeakSet = WeakSet;
  ctx.Proxy = Proxy;
  ctx.Reflect = Reflect;
  ctx.JSON = JSON;
  ctx.Math = Math;
  ctx.Number = Number;
  ctx.String = String;
  ctx.Boolean = Boolean;
  ctx.RegExp = RegExp;
  ctx.Int8Array = Int8Array;
  ctx.Uint8Array = Uint8Array;
  ctx.Uint8ClampedArray = Uint8ClampedArray;
  ctx.Int16Array = Int16Array;
  ctx.Uint16Array = Uint16Array;
  ctx.Int32Array = Int32Array;
  ctx.Uint32Array = Uint32Array;
  ctx.Float32Array = Float32Array;
  ctx.Float64Array = Float64Array;
  ctx.BigInt64Array = BigInt64Array;
  ctx.BigUint64Array = BigUint64Array;
  ctx.ArrayBuffer = ArrayBuffer;
  ctx.SharedArrayBuffer = SharedArrayBuffer;
  ctx.DataView = DataView;

  return vm.createContext(ctx);
}

// ---------------------------------------------------------------------------
// Load and evaluate scramjet.js once, then expose the $scramjet object.
// ---------------------------------------------------------------------------

let _scramjet = null;

export async function loadScramjet() {
  if (_scramjet) return _scramjet;

  const ctx = buildContext();
  let code = readFileSync(resolve(DIST, 'scramjet.js'), 'utf8');

  // ── Compatibility patch: inline regex flags ────────────────────────────
  // The scramjet bundle uses ES2024 inline regex flag syntax `(?i:url)`.
  // Node.js <23 / V8 <12.4 doesn't support this; rewrite to character class.
  code = code.replace(/\(\?i:url\)/g, '[Uu][Rr][Ll]');

  // ── WASM realm-boundary patch ──────────────────────────────────────────
  // V8 vm contexts have their own intrinsic TypedArray constructors.
  // WebAssembly.Module(uint8array) inside the vm rejects Uint8Arrays from
  // the outer realm.  Pre-compile the Module in the outer realm and inject
  // it so the bundle's init code finds __wasm_mod__ instead.
  //
  // NOTE: Apply this patch BEFORE the first vm.runInContext call so the
  // bundle only ever runs with the patch in place.  The original code ran
  // vm.runInContext twice (once without the patch, once with), which caused
  // the bundle's IIFE to execute twice — double-registering class definitions
  // and sometimes overwriting the patched code path.
  code = code.replace(
    /\(0,n\.QR\)\(\{module:new WebAssembly\.Module\(i\)\}\)/,
    '(0,n.QR)({module:globalThis.__wasm_mod__||new WebAssembly.Module(i)})'
  );

  // Pre-compile WASM in the outer realm (no realm-boundary issues).
  const wasmBuf = readFileSync(resolve(DIST, 'scramjet.wasm'));
  const wasmAB = wasmBuf.buffer.slice(
    wasmBuf.byteOffset,
    wasmBuf.byteOffset + wasmBuf.byteLength
  );
  ctx.__wasm_mod__ = new WebAssembly.Module(wasmAB);

  // Single run — bundle executes once with all patches applied.
  vm.runInContext(code, ctx, { filename: 'scramjet.js' });

  if (!ctx.$scramjet) {
    throw new Error('scramjet.js did not set globalThis.$scramjet — bundle may have changed');
  }

  // Feed WASM bytes to $scramjet.setWasm().
  // __wasm_mod__ (pre-compiled above) handles the actual Module instantiation;
  // setWasm() also needs the raw bytes for its magic-bytes check.
  ctx._WASM_B64 = wasmBuf.toString('base64');
  vm.runInContext(
    'var _wb = Uint8Array.from(atob(_WASM_B64), function(c){return c.charCodeAt(0)});' +
    '$scramjet.setWasm(_wb);' +
    'delete globalThis._WASM_B64;',
    ctx
  );

  // Log what the bundle actually exports so proxy.mjs knows what's usable.
  const exported = Object.keys(ctx.$scramjet);
  const fns = exported.filter(k => typeof ctx.$scramjet[k] === 'function');
  console.log('[loader] $scramjet exports:', exported.join(', '));
  console.log('[loader] $scramjet functions:', fns.join(', ') || '(none)');

  console.log('[loader] scramjet loaded, WASM ready');
  _scramjet = ctx.$scramjet;
  return _scramjet;
}

export function getScramjet() {
  if (!_scramjet) throw new Error('scramjet not loaded yet — call loadScramjet() first');
  return _scramjet;
}
