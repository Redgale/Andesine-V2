# ── Andesine — Dockerfile ──────────────────────────────────────────────────
# Optimized for Koyeb deployment (also works locally with docker run)
#
# Build:  docker build -t andesine .
# Run:    docker run -p 3000:3000 andesine
# Koyeb:  push to GitHub → connect repo in Koyeb → it auto-detects this file
# ───────────────────────────────────────────────────────────────────────────

# ── Stage 1: install dependencies ─────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifests first — lets Docker cache the npm layer separately
# so a code-only change doesn't re-run npm install
COPY package.json package-lock.json* ./

# Install ONLY production deps (no devDependencies)
RUN npm ci --omit=dev


# ── Stage 2: lean runtime image ───────────────────────────────────────────
FROM node:20-alpine AS runtime

# Create a non-root user for security
RUN addgroup -S andesine && adduser -S andesine -G andesine

WORKDIR /app

# Pull in production node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy the application source
COPY src/    ./src/
COPY public/ ./public/
COPY package.json ./

# Switch to non-root user
USER andesine

# Koyeb injects $PORT at runtime (typically 8080 on Koyeb, 3000 locally).
# The server already reads process.env.PORT so no code changes needed.
ENV PORT=3000
EXPOSE 3000

# Health check — Koyeb also does TCP checks, but this gives a cleaner signal
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "\
    const h = require('http'); \
    h.get('http://localhost:' + (process.env.PORT||3000) + '/', r => \
      process.exit(r.statusCode < 400 ? 0 : 1) \
    ).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
