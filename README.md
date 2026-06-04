# Andesine

A service-worker-less web proxy powered by [Scramjet](https://github.com/MercuryWorkshop/scramjet), named after the copper-red feldspar mineral.

## How it works

The traditional Scramjet requires a service worker to intercept network requests from the browser. Andesine eliminates that requirement by doing **all rewriting server-side**:

```
Browser → /~/sj/<session>/<frame>/<encoded-url> → Node server
            ↓
    Fetch real resource
            ↓
    Rewrite HTML / JS / CSS with Scramjet's WASM rewriter
            ↓
    Stream back to browser
```

WebSocket connections are handled through the **Wisp** multiplexing protocol over a single WebSocket at `/~/wisp`.

## Project structure

```
andesine/
├── server.mjs           Main Express + WebSocket server
├── src/
│   ├── proxy.mjs        Core proxy handler (server as service worker)
│   ├── loader.mjs       Loads scramjet.js + WASM into a vm.Context
│   ├── session.mjs      Per-browser cookie jar management
│   └── wisp.mjs         Wisp v1 WebSocket multiplexer
├── dist/
│   ├── scramjet.js      Scramjet bundle (browser + server rewriter)
│   └── scramjet.wasm    WASM rewriter binary
├── public/
│   ├── index.html       Andesine frontend
│   └── no-sw-inject.js  Client-side scramjet hook (no SW needed)
├── Dockerfile
└── koyeb.yaml
```

## Local development

```bash
npm install
npm start
# open http://localhost:3000
```

Requires **Node.js ≥ 20**.

## Deploy to Koyeb

### Option 1 — GitHub (recommended)

1. Push this repo to GitHub.
2. Go to [app.koyeb.com](https://app.koyeb.com) → **Create Service**.
3. Choose **GitHub** → select your repo → branch `main`.
4. Koyeb auto-detects the `Dockerfile`.
5. Set the port to **3000** and the route to **`/`**.
6. Click **Deploy**. Your service will be live at `andesine.koyeb.app`.

### Option 2 — Koyeb CLI

```bash
koyeb app create andesine
koyeb service create \
  --app andesine \
  --git github.com/<you>/andesine \
  --git-branch main \
  --port 3000:http \
  --route /:3000 \
  --name andesine \
  --regions was
```

### Option 3 — Docker directly

```bash
docker build -t andesine .
docker run -p 3000:3000 -e PORT=3000 andesine
```

## URL scheme

```
/~/sj/<sessionId>/<frameId>/<encodeURIComponent(targetUrl)>
```

- **sessionId** — per-browser session (from `_sjsid` cookie)
- **frameId** — per-page-load random ID
- **encodedUrl** — `encodeURIComponent(realUrl)`

Navigate to any site via: `GET /~/go?url=https://example.com`

## Endpoints

| Path | Description |
|------|-------------|
| `GET /` | Andesine frontend |
| `GET /~/go?url=…` | Redirect into proxy for a URL |
| `GET /~/session` | Issue / return `_sjsid` session cookie |
| `GET /~/health` | Health check (`{"status":"ok"}`) |
| `GET /~/sj/…` | Proxy handler |
| `WS  /~/wisp` | Wisp v1 WebSocket multiplexer |
| `GET /scramjet.js` | Scramjet browser bundle |
