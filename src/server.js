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
  const distDir  = path.join(nodeModules, pkgName, "dist");
  const pkgRoot  = path.join(nodeModules, pkgName);

  if (fs.existsSync(distDir)) {
    return distDir;
  }

  console.warn(`[Andesine] ${pkgName}: no dist/ found, falling back to package root`);
  return pkgRoot;
}

// ── Scramjet: resolve the static dist directory ────────────────────────────
// The controller-based setup needs the plain IIFE build (scramjet.js) and
// the WASM file — both live in the standard dist/.
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
  // Scramjet: IIFE bundle (sets globalThis.$scramjet) + WASM
  ["/scram/scramjet.js",           path.join(scramjetStaticPath, "scramjet.js")],
  ["/scram/scramjet.mjs",          path.join(scramjetStaticPath, "scramjet.mjs")],
  ["/scram/scramjet.wasm",         path.join(scramjetStaticPath, "scramjet.wasm")],
  // Controller: SW bundle, API bundle, inject bundle
  ["/controller/controller.sw.js",     path.join(controllerPath, "controller.sw.js")],
  ["/controller/controller.api.js",    path.join(controllerPath, "controller.api.js")],
  ["/controller/controller.inject.js", path.join(controllerPath, "controller.inject.js")],
  // Transports: loaded via dynamic import() in the browser
  ["/epoxy/index.mjs",             path.join(epoxyPath,   "index.mjs")],
  ["/libcurl/index.mjs",           path.join(libcurlPath, "index.mjs")],
  // BareMux worker (kept for optional use, not required by the controller path)
  ["/baremux/worker.js",           path.join(baremuxPath, "worker.js")],
];

console.log("[Andesine] ── Key file check ───────────────────────────────────");
for (const [url, absPath] of criticalFiles) {
  const exists = fs.existsSync(absPath);
  console.log(`  ${exists ? "✓" : "✗ MISSING"} ${url}`);
  if (!exists) {
    const dir = path.dirname(absPath);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      console.log(`      ↳ dir contains: ${files.join(", ")}`);
    } else {
      console.log(`      ↳ parent dir does not exist: ${dir}`);
    }
  }
}
console.log("[Andesine] ────────────────────────────────────────────────────\n");

// ── Server ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const app  = Fastify({ logger: false });

// ── MIME type enforcement ─────────────────────────────────────────────────
// .mjs must be served as text/javascript for dynamic import() to work.
// .wasm must be served as application/wasm for WebAssembly.instantiateStreaming().
app.addHook("onSend", async (request, reply, payload) => {
  const url = request.url.split("?")[0];
  if (url.endsWith(".mjs")) {
    reply.header("Content-Type", "text/javascript; charset=utf-8");
  } else if (url.endsWith(".wasm")) {
    reply.header("Content-Type", "application/wasm");
  }
  return payload;
});

// ── Static file registrations ─────────────────────────────────────────────
// Rule: the FIRST registration omits decorateReply (defaults to true).
// Every subsequent registration must set decorateReply: false.

await app.register(staticPlugin, {
  root:   scramjetStaticPath,
  prefix: "/scram/",
  // decorateReply: true (default) — intentionally omitted on the first registration
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
