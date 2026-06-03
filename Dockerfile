# ─── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install pnpm and dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm run build

# ─── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy manifests and install prod-only deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm && pnpm install --prod --frozen-lockfile

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Cloud Run injects PORT env var (default 6399)
EXPOSE 6399

# Use exec form so SIGTERM reaches the Node process (graceful shutdown)
CMD ["node", "dist/index.js"]