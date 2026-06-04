# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS deps

WORKDIR /app

# Copy only the manifest first so Docker can cache the npm install layer
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Security: drop privileges
RUN groupadd --system andesine && useradd --system --gid andesine andesine

WORKDIR /app

# Copy installed node_modules from the build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY package.json     ./
COPY server.mjs       ./
COPY src/             ./src/
COPY dist/            ./dist/
COPY public/          ./public/

# Koyeb injects PORT at runtime; we fall back to 3000 for local dev
ENV PORT=3000
ENV NODE_ENV=production

# Drop to non-root user
USER andesine

EXPOSE 3000

# Use exec form so signals reach the process (no shell wrapper)
CMD ["node", "server.mjs"]
