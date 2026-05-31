import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { server as wispServer } from "@mercuryworkshop/wisp-js/server";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir   = path.join(__dirname, "..");
const nodeModules = path.join(rootDir, "node_modules");

// ── Utility: resolve a package's static dist directory ────────────────────
function resolvePackageDist(pkgName) {
  const distDir = path.join(nodeModules, pkgName, "dist");
  const pkgRoot = path.join(nodeModules, pkgName);
  if (fs.existsSync(distDir)) return distDir;
  console.warn(`[Andesine] ${pkgName}: no dist/ found, falling back to package root`);
  return pkgRoot;
}

// ── Scramjet: resolve the static dist directory ────────────────────────────
let scramjetStaticPath;
try {
  const mod = await import("@mercuryworkshop/scramjet/path");
  const candidate = mod.scramjetPath ?? mod.default;
  if (typeof candidate === "string" && fs.existsSync(candidate)) {
    scramjetStaticPath = candidate;
  } else {
    throw new Error(
      `@mercuryworkshop/scramjet/path resolved to ${JSON.stringify(candidate)}, which is not a valid directory`
    );
  }
} catch (err) {
  console.warn(`[Andesine] scramjet/path import failed: ${err.message}`);
  console.warn("[Andesine] Falling back to manual dist resolution for scramjet");
  scramjetStaticPath = resolvePackageDist("@mercuryworkshop/scramjet");
}

const controllerPath = resolvePackageDist("@mercuryworkshop/scramjet-controller");
const baremuxPath    = resolvePackageDist("@mercuryworkshop/bare-mux");
const epoxyPath      = resolvePackageDist("@mercuryworkshop/epoxy-transport");
const libcurlPath    = resolvePackageDist("@mercuryworkshop/libcurl-transport");

// ── Diagnostic logging ─────────────────────────────────────────────────────
console.log("\n[Andesine] ── Static path resolution ──────────────────────────");
console.log("  scramjet    →", scramjetStaticPath);
console.log("  controller  →", controllerPath);
console.log("  baremux     →", baremuxPath);
console.log("  epoxy       →", epoxyPath);
console.log("  libcurl     →", libcurlPath);

const criticalFiles = [
  ["/scram/scramjet.js",               path.join(scramjetStaticPath, "scramjet.js")],
  ["/scram/scramjet.mjs",              path.join(scramjetStaticPath, "scramjet.mjs")],
  ["/scram/scramjet.wasm",             path.join(scramjetStaticPath, "scramjet.wasm")],
  ["/controller/controller.sw.js",     path.join(controllerPath, "controller.sw.js")],
  ["/controller/controller.api.js",    path.join(controllerPath, "controller.api.js")],
  ["/controller/controller.inject.js", path.join(controllerPath, "controller.inject.js")],
  ["/epoxy/index.mjs",                 path.join(epoxyPath,   "index.mjs")],
  ["/libcurl/index.mjs",               path.join(libcurlPath, "index.mjs")],
  ["/baremux/worker.js",               path.join(baremuxPath, "worker.js")],
];

console.log("[Andesine] ── Key file check ───────────────────────────────────");
for (const [url, absPath] of criticalFiles) {
  const exists = fs.existsSync(absPath);
  console.log(`  ${exists ? "✓" : "✗ MISSING"} ${url}`);
  if (!exists) {
    const dir = path.dirname(absPath);
    if (fs.existsSync(dir)) {
      console.log(`      ↳ dir contains: ${fs.readdirSync(dir).join(", ")}`);
    } else {
      console.log(`      ↳ parent dir does not exist: ${dir}`);
    }
  }
}
console.log("[Andesine] ────────────────────────────────────────────────────\n");

// ── Read index.html template once at startup ──────────────────────────────
const indexHtmlPath     = path.join(rootDir, "public", "index.html");
const indexHtmlTemplate = fs.readFileSync(indexHtmlPath, "utf8");

// ── Pre-read and inline controller.sw.js ─────────────────────────────────
//
// WHY THIS EXISTS:
// When the UI runs from a blob URL, browser extensions (uBlock Origin,
// Privacy Badger, etc.) that implement webRequest / declarativeNetRequest
// can intercept and block two separate HTTP fetches that normally occur
// during SW bootstrap:
//
//   1. navigator.serviceWorker.register('/sw.js')    ← browser fetches /sw.js
//   2. importScripts('/controller/controller.sw.js') ← fetch inside the SW
//
// Both are real HTTP/HTTPS requests that extensions can pattern-match and
// kill, causing the entire proxy init to fail silently.
//
// THE FIX:
// Read controller.sw.js from disk here at server startup and stitch it
// together with the fetch-routing handler into a single COMBINED_SW_SOURCE
// string.  That string is then JSON-serialised into the proxy-engine HTML
// response as a plain string literal, requiring ZERO extra HTTP fetches.
//
// On the client, registration becomes:
//
//   const blob  = new Blob([COMBINED_SW_SOURCE], { type: 'text/javascript' });
//   const swUrl = URL.createObjectURL(blob);          // in-process, no network
//   navigator.serviceWorker.register(swUrl, { scope: '/' });
//
// URL.createObjectURL() is a synchronous, in-process call — it produces a
// blob: URI that inherits the creating document's real origin
// (e.g. blob:https://your-app.koyeb.app/...).  The browser's internal
// resolution of a blob: SW URL is opaque to webRequest / declarativeNetRequest,
// so there is nothing for extensions to intercept.
//
// /sw.js is kept as a hard-refresh / direct-navigation fallback.
// ─────────────────────────────────────────────────────────────────────────

let controllerSwInline = "";
const controllerSwFile = path.join(controllerPath, "controller.sw.js");
try {
  if (fs.existsSync(controllerSwFile)) {
    controllerSwInline = fs.readFileSync(controllerSwFile, "utf8");
    console.log("[Andesine] controller.sw.js read for inline embedding ✓");
  } else {
    console.warn("[Andesine] controller.sw.js not found — blob SW will be skipped; falling back to /sw.js");
  }
} catch (err) {
  console.warn("[Andesine] Could not read controller.sw.js:", err.message, "— falling back to /sw.js");
}

// Combined SW source: controller bundle first (sets self.$scramjetController
// and wires install / activate / message handlers), then our fetch handler.
// Written as a classic (non-module) SW — no top-level await, no import().
const COMBINED_SW_SOURCE = [
  "// Andesine — Combined Service Worker (server-inlined, extension-proof)",
  "// controller.sw.js sets self.$scramjetController; wires install + activate.",
  "",
  controllerSwInline,
  "",
  "// Fetch routing — $scramjetController is available from the inlined bundle above.",
  "self.addEventListener('fetch', function (event) {",
  "  if (typeof $scramjetController !== 'undefined' && $scramjetController.shouldRoute(event)) {",
  "    event.respondWith($scramjetController.route(event));",
  "  }",
  "});",
].join("\n");

// ── Server-origin helper (handles Koyeb reverse-proxy headers) ────────────
function getServerOrigin(request) {
  const proto = (request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim()
    || request.protocol
    || "https";
  const host  = (request.headers["x-forwarded-host"] ?? "").split(",")[0].trim()
    || request.hostname;
  return `${proto}://${host}`;
}

// ── /proxy-engine page ────────────────────────────────────────────────────
// Lives on the real koyeb.app origin so it can:
//   • register the service worker (same-origin requirement satisfied)
//   • initialise the scramjet Controller
//   • relay navigation/events to the blob-origin parent via postMessage
function buildProxyEngineHtml() {
  // JSON.stringify safely encodes the raw JS source into a string literal
  // that can be embedded directly in a <script> block without XSS risk.
  // The browser decodes it back to a string; we pass that to Blob — no HTTP.
  const swCodeLiteral = JSON.stringify(COMBINED_SW_SOURCE);
  const hasSWInline   = controllerSwInline.length > 0;

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; background: transparent; }
    #proxy-frame {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      border: none;
      background: #fff;
    }
  </style>
  <!-- Scramjet IIFE — sets globalThis.$scramjet -->
  <script src="/scram/scramjet.js"></script>
  <!-- Controller API — sets globalThis.$scramjetController -->
  <script src="/controller/controller.api.js"></script>
</head>
<body>
  <!--
    allow-pointer-lock  : lets pages inside the proxy request pointer lock
    allow-same-origin   : required so the SW can intercept requests on the same origin
    allow="pointer-lock *" is set via the allow attribute on this element too
  -->
  <iframe
    id="proxy-frame"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock"
    allow="pointer-lock *"
  ></iframe>

  <script type="module">
  // ── Inlined SW source ────────────────────────────────────────────────────
  // controller.sw.js + our fetch handler, baked into this HTML at server
  // startup.  Registering via Blob avoids every network request extensions
  // could intercept (no /sw.js fetch, no importScripts fetch inside the SW).
  const __SW_SOURCE__   = ${swCodeLiteral};
  const __SW_HAS_CODE__ = ${hasSWInline};

  (async () => {
    // ── Helpers ─────────────────────────────────────────────────────────
    function send(msg) {
      try { window.parent.postMessage(msg, "*"); } catch (_) {}
    }

    let controller = null;
    let frame      = null;
    let ready      = false;

    // ── Transport builder ────────────────────────────────────────────────
    async function buildTransport(wispUrl, type) {
      if (type === "libcurl") {
        const mod = await import("/libcurl/index.mjs");
        const LibcurlClient = mod.default ?? mod.LibcurlClient;
        const t = new LibcurlClient({ wisp: wispUrl });
        await t.init();
        return t;
      }
      const { default: EpoxyTransport } = await import("/epoxy/index.mjs");
      const t = new EpoxyTransport({ wisp: wispUrl });
      await t.init();
      return t;
    }

    // ── Service Worker registration ───────────────────────────────────────
    //
    // Strategy:
    //
    //   PRIMARY — Blob URL (extension-proof):
    //     URL.createObjectURL() is an in-process, synchronous call.
    //     Extensions' webRequest / declarativeNetRequest hooks only fire on
    //     real HTTP/HTTPS traffic; they cannot see blob object creation or
    //     the browser's internal resolution of a blob: SW URL.
    //     The resulting blob: URL inherits this page's real origin so the
    //     browser accepts scope "/" without complaint.
    //
    //   FALLBACK — /sw.js file path:
    //     Used when __SW_HAS_CODE__ is false (controller.sw.js was missing
    //     from disk at server startup) or if Blob construction throws for
    //     any browser-specific reason.
    //
    async function registerServiceWorker() {
      if (!("serviceWorker" in navigator)) {
        throw new Error("Service Workers not supported");
      }

      if (__SW_HAS_CODE__) {
        try {
          const blob  = new Blob([__SW_SOURCE__], { type: "text/javascript" });
          const swUrl = URL.createObjectURL(blob);
          // Do NOT revoke swUrl — the browser may need it to verify / update
          // the SW script.  It is released automatically when the page unloads.
          await navigator.serviceWorker.register(swUrl, { scope: "/" });
          console.log("[proxy-engine] SW registered via blob URL (extension-proof) ✓");
        } catch (blobErr) {
          // Blob path failed — fall through to the file-based URL.
          console.warn("[proxy-engine] Blob SW registration failed, falling back to /sw.js:", blobErr.message);
          await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        }
      } else {
        // No inline code available (server startup couldn't read the file).
        console.warn("[proxy-engine] No inline SW code; using /sw.js fallback");
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      }

      const reg = await navigator.serviceWorker.ready;
      const sw  = reg.active;
      if (!sw) throw new Error("Service worker did not activate");
      return sw;
    }

    // ── Init ─────────────────────────────────────────────────────────────
    async function init({ wispUrl = "wss://wisp.mercurywork.shop/", transportType = "epoxy" } = {}) {
      try {
        send({ type: "STATUS", msg: "REGISTERING SERVICE WORKER" });

        const sw = await registerServiceWorker();

        send({ type: "STATUS", msg: "CONFIGURING TRANSPORT" });

        let transport;
        let effectiveWisp = wispUrl;
        try {
          transport = await buildTransport(wispUrl, transportType);
        } catch (err) {
          console.warn("[proxy-engine] Transport failed, falling back to public wisp:", err);
          effectiveWisp = "wss://wisp.mercurywork.shop/";
          transport = await buildTransport(effectiveWisp, "epoxy");
          send({ type: "TRANSPORT_FALLBACK", wispUrl: effectiveWisp });
        }

        send({ type: "STATUS", msg: "INITIALIZING CONTROLLER" });

        const { Controller } = $scramjetController;
        const proxyFrame = document.getElementById("proxy-frame");

        controller = new Controller({
          serviceworker: sw,
          transport,
          config: {
            scramjetPath:    "/scram/scramjet.js",
            wasmPath:        "/scram/scramjet.wasm",
            injectPath:      "/controller/controller.inject.js",
            virtualWasmPath: "scramjet.wasm.js",
          },
        });

        await controller.wait();
        frame = controller.createFrame(proxyFrame);
        ready = true;

        send({ type: "READY" });

        // ── URL tracking ─────────────────────────────────────────────────
        proxyFrame.addEventListener("load", () => {
          send({ type: "LOAD_COMPLETE" });
          try {
            const loc = proxyFrame.contentWindow?.location?.href;
            if (loc && loc !== "about:blank" && frame) {
              const prefix = frame.prefix;
              let displayUrl = loc;
              try {
                const p = new URL(loc, location.href).pathname;
                if (p.startsWith(prefix)) displayUrl = decodeURIComponent(p.slice(prefix.length));
              } catch (_) {}
              send({ type: "URL_CHANGE", url: displayUrl });
            }
          } catch (_) {}
        });

        // ── Pointer-lock relay ────────────────────────────────────────────
        document.addEventListener("pointerlockchange", () => {
          send({ type: "POINTER_LOCK", locked: document.pointerLockElement !== null });
        });

      } catch (err) {
        console.error("[proxy-engine] Init error:", err);
        send({ type: "ERROR", message: err.message });
      }
    }

    // ── Command listener ─────────────────────────────────────────────────
    window.addEventListener("message", async (e) => {
      const data = e.data;
      if (!data || typeof data !== "object") return;
      switch (data.type) {
        case "INIT":        await init(data); break;
        case "NAVIGATE":    if (frame && ready) frame.go(data.url); break;
        case "BACK":        if (frame) frame.back();    break;
        case "FORWARD":     if (frame) frame.forward(); break;
        case "RELOAD":      if (frame) frame.reload();  break;
        case "SET_TRANSPORT":
          if (controller) {
            try {
              const t = await buildTransport(data.wispUrl, data.transportType);
              controller.setTransport(t);
              send({ type: "TRANSPORT_OK" });
            } catch (err) {
              send({ type: "TRANSPORT_ERR", message: err.message });
            }
          }
          break;
      }
    });

    // Signal ready to receive INIT command
    send({ type: "ENGINE_LOADED" });
  })();
  </script>
</body>
</html>`;
}

// ── Server ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const app  = Fastify({ logger: false });

// ── MIME type enforcement ─────────────────────────────────────────────────
app.addHook("onSend", async (request, reply, payload) => {
  const url = request.url.split("?")[0];
  if (url.endsWith(".mjs"))  reply.header("Content-Type", "text/javascript; charset=utf-8");
  if (url.endsWith(".wasm")) reply.header("Content-Type", "application/wasm");
  return payload;
});

// ── Dynamic GET / ─────────────────────────────────────────────────────────
// Injects <base href> + window.ANDESINE_SERVER so that when index.html is
// fetched and turned into a blob:// URL, all relative asset paths still
// resolve to the real koyeb.app origin, and the UI shell knows where to
// point the /proxy-engine iframe.
// Registered BEFORE the static plugin so this route wins.
app.get("/", async (request, reply) => {
  const serverOrigin = getServerOrigin(request);
  const injection =
    `\n  <base href="${serverOrigin}/">\n` +
    `  <script>window.ANDESINE_SERVER = ${JSON.stringify(serverOrigin)};</script>\n`;
  const html = indexHtmlTemplate.replace(/(<head[^>]*>)/i, `$1${injection}`);
  reply.header("Content-Type", "text/html; charset=utf-8").send(html);
});

// ── GET /proxy-engine ─────────────────────────────────────────────────────
// Same-origin host page that owns the service worker + scramjet controller.
// The blob-URL shell embeds this in an iframe and talks to it via postMessage.
app.get("/proxy-engine", async (_request, reply) => {
  reply
    .header("Content-Type", "text/html; charset=utf-8")
    .send(buildProxyEngineHtml());
});

// ── Static file registrations ─────────────────────────────────────────────
// Rule: first registration omits decorateReply (defaults to true);
// every subsequent one sets decorateReply: false.

await app.register(staticPlugin, {
  root:   scramjetStaticPath,
  prefix: "/scram/",
});

await app.register(staticPlugin, {
  root:          controllerPath,
  prefix:        "/controller/",
  decorateReply: false,
});

await app.register(staticPlugin, {
  root:          baremuxPath,
  prefix:        "/baremux/",
  decorateReply: false,
});

await app.register(staticPlugin, {
  root:          epoxyPath,
  prefix:        "/epoxy/",
  decorateReply: false,
});

await app.register(staticPlugin, {
  root:          libcurlPath,
  prefix:        "/libcurl/",
  decorateReply: false,
});

await app.register(staticPlugin, {
  root:          path.join(rootDir, "public"),
  prefix:        "/",
  decorateReply: false,
});

// ── Start ─────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`╔══════════════════════════════════════╗`);
  console.log(`║   🔴 ANDESINE PROXY — ACTIVE 🔴     ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Frontend → http://localhost:${PORT}     ║`);
  console.log(`║  Wisp     → ws://localhost:${PORT}/wisp/ ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
} catch (err) {
  console.error("Error starting Andesine:", err);
  process.exit(1);
}

// ── Wisp WebSocket handler ────────────────────────────────────────────────
app.server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) {
    wispServer.routeRequest(req, socket, head);
  } else {
    socket.end();
  }
});
