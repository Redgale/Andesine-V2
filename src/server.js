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
// Checks dist/ first, then the package root. Logs what it finds so you can
// verify paths in Koyeb logs without shelling into the container.
function resolvePackageDist(pkgName) {
  const distDir  = path.join(nodeModules, pkgName, "dist");
  const pkgRoot  = path.join(nodeModules, pkgName);

  if (fs.existsSync(distDir)) {
    return distDir;
  }

  console.warn(`[Andesine] ${pkgName}: no dist/ found, falling back to package root`);
  return pkgRoot;
}

// ── Scramjet: path subexport is not guaranteed in every alpha build ────────
// If the named export is missing / undefined / points at a non-existent dir,
// we fall back to the standard dist/ layout used by every published release.
let scramjetStaticPath;
try {
  const mod = await import("@mercuryworkshop/scramjet/path");

  // The module may use a named export OR a default export — handle both.
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

const baremuxPath = resolvePackageDist("@mercuryworkshop/bare-mux");
const epoxyPath   = resolvePackageDist("@mercuryworkshop/epoxy-transport");
const libcurlPath = resolvePackageDist("@mercuryworkshop/libcurl-transport");

// ── Diagnostic: log every resolved path and check critical files ──────────
// These lines appear in Koyeb → Deployments → Logs immediately on startup.
// Check them first when debugging a blank proxy page.
console.log("\n[Andesine] ── Static path resolution ──────────────────────────");
console.log("  scramjet  →", scramjetStaticPath);
console.log("  baremux   →", baremuxPath);
console.log("  epoxy     →", epoxyPath);
console.log("  libcurl   →", libcurlPath);

const criticalFiles = [
  // Scramjet: all three files must exist for the controller + SW to work
  ["/scram/scramjet.all.js",   path.join(scramjetStaticPath, "scramjet.all.js")],
  ["/scram/scramjet.wasm.wasm",path.join(scramjetStaticPath, "scramjet.wasm.wasm")],
  ["/scram/scramjet.sync.js",  path.join(scramjetStaticPath, "scramjet.sync.js")],
  // Transports: bare-mux dynamically imports these as ES modules
  ["/epoxy/index.mjs",         path.join(epoxyPath,   "index.mjs")],
  ["/libcurl/index.mjs",       path.join(libcurlPath, "index.mjs")],
  // BareMux worker: loaded by new BareMux.BareMuxConnection(...)
  ["/baremux/worker.js",       path.join(baremuxPath, "worker.js")],
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
// CRITICAL — without these headers browsers hard-reject:
//   • dynamic import() of .mjs served as application/octet-stream
//   • WebAssembly.instantiateStreaming() of .wasm served as anything other than application/wasm
//
// @fastify/static delegates to the `mime` npm package; older mime-db versions
// omit .mjs and older Node builds may send the wrong type for .wasm.
// This hook runs before every response and guarantees correctness.
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
// Rule: the FIRST @fastify/static registration must NOT set decorateReply: false
// (it defaults to true). Every subsequent registration must set it to false to
// avoid "Reply already decorated with 'sendFile'" errors.

await app.register(staticPlugin, {
  root:   scramjetStaticPath,
  prefix: "/scram/",
  // decorateReply defaults to true — intentionally omitted here
});

await app.register(staticPlugin, {
  root:            baremuxPath,
  prefix:          "/baremux/",
  decorateReply:   false,
});

await app.register(staticPlugin, {
  root:            epoxyPath,
  prefix:          "/epoxy/",
  decorateReply:   false,
});

await app.register(staticPlugin, {
  root:            libcurlPath,
  prefix:          "/libcurl/",
  decorateReply:   false,
});

await app.register(staticPlugin, {
  root:            path.join(rootDir, "public"),
  prefix:          "/",
  decorateReply:   false,
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
