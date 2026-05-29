import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { server as wispServer } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const nodeModules = path.join(rootDir, "node_modules");

const baremuxPath  = path.join(nodeModules, "@mercuryworkshop/bare-mux/dist");
const epoxyPath    = path.join(nodeModules, "@mercuryworkshop/epoxy-transport/dist");
const libcurlPath  = path.join(nodeModules, "@mercuryworkshop/libcurl-transport/dist");

const PORT = process.env.PORT || 3000;

const app = Fastify({ logger: false });

// Serve Scramjet files at /scram/
await app.register(staticPlugin, {
  root: scramjetPath,
  prefix: "/scram/",
  decorateReply: false,
});

// Serve BareMux files at /baremux/
await app.register(staticPlugin, {
  root: baremuxPath,
  prefix: "/baremux/",
  decorateReply: false,
});

// Serve Epoxy transport at /epoxy/
await app.register(staticPlugin, {
  root: epoxyPath,
  prefix: "/epoxy/",
  decorateReply: false,
});

// Serve libcurl transport at /libcurl/
await app.register(staticPlugin, {
  root: libcurlPath,
  prefix: "/libcurl/",
  decorateReply: false,
});

// Serve public frontend
await app.register(staticPlugin, {
  root: path.join(rootDir, "public"),
  prefix: "/",
  decorateReply: false,
});

// Start the server
try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   🔴 ANDESINE PROXY — ACTIVE 🔴     ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Frontend → http://localhost:${PORT}     ║`);
  console.log(`║  Wisp     → ws://localhost:${PORT}/wisp/ ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
} catch (err) {
  console.error("Error starting Andesine:", err);
  process.exit(1);
}

// Attach Wisp WebSocket handler on /wisp/ path
app.server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) {
    wispServer.routeRequest(req, socket, head);
  } else {
    socket.end();
  }
});
