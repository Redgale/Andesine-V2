# ◆ ANDESINE

> A fully-featured Scramjet web proxy with a custom red-black mineral aesthetic.
> Named after the andesine feldspar mineral.

---

## What it is

Andesine is a browser-based web proxy built on the [Scramjet](https://github.com/MercuryWorkshop/scramjet) engine by Mercury Workshop. It lets you browse the internet through a service worker that intercepts, rewrites, and tunnels your traffic through a Wisp WebSocket server — bypassing network restrictions entirely in the browser.

### Tech stack

| Layer | Library |
|---|---|
| Proxy engine | `@mercuryworkshop/scramjet` v1.1.0 |
| Transport layer | `@mercuryworkshop/bare-mux` |
| HTTPS transports | `epoxy-transport` + `libcurl-transport` |
| Wisp server | `@mercuryworkshop/wisp-js` |
| HTTP server | `fastify` v5 |

---

## Setup

### Requirements
- Node.js 18+ (or 20 recommended)
- npm or pnpm

### Install & run

```bash
# Clone / download and enter the folder
cd andesine

# Install dependencies
npm install

# Start the server
npm start
```

Then open **http://localhost:3000** in your browser.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to listen on |

---

## How it works

```
Browser ──fetch──► Service Worker (sw.js)
                        │ intercepts & rewrites
                        ▼
              Scramjet Engine (/scram/*)
                        │ routes traffic through transport
                        ▼
              BareMux Transport Layer (/baremux/*)
                        │ selects protocol
                   ┌────┴────┐
                   ▼         ▼
              Epoxy        libcurl
            (/epoxy/*)   (/libcurl/*)
                   │         │
                   └────┬────┘
                        ▼  WebSocket
              Wisp Server (/wisp/)
                        │  TCP/UDP multiplexed
                        ▼
                   Internet 🌐
```

### Served routes

| Route | Content |
|---|---|
| `/` | Andesine frontend |
| `/sw.js` | Scramjet service worker |
| `/scram/*` | Scramjet engine bundle + WASM |
| `/baremux/*` | BareMux transport manager |
| `/epoxy/*` | Epoxy transport (end-to-end encrypted via Wisp) |
| `/libcurl/*` | libcurl transport (alternative encrypted transport) |
| `/wisp/` | WebSocket Wisp server endpoint |

---

## Transports

Andesine includes two transport options, selectable in the UI:

**Epoxy** (default) — Uses `epoxy-tls` + Wisp. Lightweight and fast.

**libcurl** — Uses `libcurl.js` + Wisp. Broader compatibility with some sites.

Both encrypt your traffic between the browser and the Wisp backend.

### Public Wisp servers

If you don't want to run your own Wisp backend, you can use:
- `wss://wisp.mercurywork.shop/` — public server by Mercury Workshop

### Self-hosted Wisp

The Andesine server includes a Wisp server at `/wisp/`. Just set the Wisp URL in the settings strip to:
```
ws://localhost:3000/wisp/
```
(or `wss://` if you're behind an SSL-terminating reverse proxy)

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | Navigate to URL |
| `Ctrl+L` | Focus address bar |
| `Escape` | Return to home |

---

## Production deployment

For production (nginx + HTTPS), add to your nginx config:

```nginx
location /wisp/ {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}

location / {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

With HTTPS + nginx handling SSL, use `wss://yourdomain.com/wisp/` as the Wisp URL.

---

## License

AGPL-3.0 — same as Scramjet upstream.
