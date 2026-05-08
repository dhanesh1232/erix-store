# ─── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy manifests first for layer caching
COPY package*.json ./

# CHANGE: Using 'npm install' instead of 'npm ci' if you don't have a lockfile
RUN npm install --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

# ─── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy manifests and install prod-only deps
COPY package*.json ./

# CHANGE: Using 'npm install' here as well for consistency
RUN npm install --omit=dev --ignore-scripts

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Render's health check expects the process to listen on PORT
EXPOSE 6399

# Use exec form so SIGTERM reaches the Node process (not a shell)
CMD ["node", "dist/index.js"]