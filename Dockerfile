# ─── Stage 1: Build ────────────────────────────────────────────────────────────
# Node 22: pnpm 11 requires Node >=22.13 (uses node:sqlite). Matches ECOD/server.
FROM node:22-slim AS builder

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install pnpm and dependencies
# Pinned to the local pnpm so remote builds behave like local ones.
RUN npm install -g pnpm@11.24.0 && pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm run build

# ─── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy manifests and install prod-only deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@11.24.0 && pnpm install --prod --frozen-lockfile

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# PORT env var (default 6399; infra/vps docker-compose forces it)
EXPOSE 6399

# Use exec form so SIGTERM reaches the Node process (graceful shutdown)
CMD ["node", "dist/index.js"]