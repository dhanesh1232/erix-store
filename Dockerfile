# ─── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy manifests first for layer caching
COPY package*.json ./

# Install ALL deps (including devDeps — needed for tsc)
RUN npm ci --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

# ─── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy manifests and install prod-only deps
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Render's health check expects the process to listen on PORT
EXPOSE 6399

# Use exec form so SIGTERM reaches the Node process (not a shell)
CMD ["node", "dist/index.js"]
