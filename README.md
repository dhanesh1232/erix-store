# erix-store

A single-threaded, in-memory data structure server — like Redis, but with built-in job queues, distributed locks, caching, pub/sub, rate limiting, anomaly detection, and semantic search. Persists to PostgreSQL via WAL + snapshots.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Quick Start](#quick-start)
3. [Environment Variables](#environment-variables)
4. [Client SDK](#client-sdk)
5. [Worker Package](#worker-package)
6. [API Reference](#api-reference)
7. [WebSocket Transport](#websocket-transport)
8. [Multi-Tenant Isolation](#multi-tenant-isolation)
9. [Persistence Model](#persistence-model)
10. [Deployment](#deployment)
11. [Monitoring](#monitoring)
12. [Security](#security)
13. [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Application                          │
│                                                             │
│  ┌────────────────────┐      ┌──────────────────────┐      │
│  │  @ecodrix/         │      │  @ecodrix/           │      │
│  │  erix-client       │      │  erix-worker         │      │
│  │  (like Redis)      │      │  (like BullMQ)       │      │
│  └────────┬───────────┘      └──────────┬───────────┘      │
│           │                             │                   │
└───────────┼─────────────────────────────┼───────────────────┘
            │  HTTP / WebSocket (msgpack)  │
            └──────────────┬──────────────┘
                           ▼
                ┌──────────────────────┐
                │    erix-store        │
                │  (in-memory engine)  │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │     PostgreSQL       │
                │  (WAL + Snapshots)   │
                └──────────────────────┘
```

**Packages:**

| Package | Role | Analogy |
|---------|------|---------|
| `erix-store` | Server process | Redis server |
| `@ecodrix/erix-client` | Client SDK (v1.1.0) | Redis client |
| `@ecodrix/erix-worker` | Job processor | BullMQ Worker |

---

## Quick Start

### 1. Install and configure

```bash
cd erix-store
pnpm install

# Copy env template
cp .env.example .env
# Edit .env with your DATABASE_URL and ERIX_API_KEY
```

### 2. Run the server

```bash
# Development (auto-reload)
pnpm dev

# Production
pnpm build
pnpm start
```

You'll see:

```
🚀 ErixStore running on port 6399
   ├─ Job Queue       (WAL-backed, priority + DLQ + retry + heartbeat)
   ├─ Distributed Locks  (mutex, R/W, semaphore)
   ├─ LRU Cache       (512 MB, tag-based + SWR)
   ├─ Pub/Sub         (event bus + SSE delivery)
   ├─ Rate Limiter    (sliding window)
   ├─ Anomaly Detector (Z-score, pub/sub alerts)
   ├─ Usage Meter     (per-tenant, Postgres flush)
   ├─ Semantic Cache  (Google embeddings)
   ├─ WebSocket       (binary MessagePack, same port)
   └─ Snapshots       → PostgreSQL (every 5 min)
```

### 3. Use from another project

```bash
pnpm add @ecodrix/erix-client @ecodrix/erix-worker
```

```typescript
import { ErixClient } from '@ecodrix/erix-client'
import { ErixWorker } from '@ecodrix/erix-worker'

const client = new ErixClient({
  baseUrl: 'https://erix-store.onrender.com',
  apiKey: process.env.ERIX_API_KEY!,
  tenantId: 'org_abc123',
})

// Store data
await client.set('user:42', { name: 'Dhanesh', role: 'admin' }, 3600)
const user = await client.get<User>('user:42')

// Enqueue a job
await client.queueV2.push('email-queue', { to: 'user@example.com', subject: 'Welcome!' })

// Process jobs
const worker = new ErixWorker(client, 'email-queue', async (job) => {
  await sendEmail(job.data.to, job.data.subject)
})
worker.run()
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Supabase, Neon, Render Postgres) |
| `ERIX_API_KEY` | Yes | Shared secret for `x-erix-key` header authentication |
| `PORT` | No | Listen port (default: `6399`) |
| `NODE_ENV` | No | `development` or `production` |
| `GOOGLE_API_KEY` | No | Enables semantic cache (Google embeddings) |

Generate an API key:

```bash
node -e "console.log('erix_' + require('crypto').randomBytes(32).toString('hex'))"
```

---

## Client SDK

### Installation

```bash
pnpm add @ecodrix/erix-client
```

### Initialization

```typescript
import { ErixClient } from '@ecodrix/erix-client'

const store = new ErixClient({
  baseUrl: process.env.ERIX_STORE_URL!,
  apiKey: process.env.ERIX_API_KEY!,
  tenantId: 'org_abc123',
  transport: 'auto',  // 'auto' | 'ws' | 'http' (default: 'auto')
  timeoutMs: 5000,
})
```

Transport modes:
- **`auto`** (default): WebSocket first, falls back to HTTP if unavailable
- **`ws`**: WebSocket only (binary MessagePack, lowest latency)
- **`http`**: HTTP only (original behavior, maximum compatibility)

### Core Operations

```typescript
// Key/Value
await store.set('key', value, ttlSeconds?)
const val = await store.get<T>('key')
await store.del('key')

// Hash
await store.hash.hset('settings', 'theme', 'dark')
const theme = await store.hash.hget<string>('settings', 'theme')
const all = await store.hash.hgetall('settings')

// List
await store.list.rpush('queue', item)
await store.list.lpush('queue', item)
const item = await store.list.lpop<T>('queue')

// Set
await store.set_.sadd('tags', 'important')
const members = await store.set_.smembers('tags')

// Rate Limiter
const { allowed, remaining, resetAt } = await store.rateLimit('api:org1', 100, 60)

// Pub/Sub
await store.pubsub.publish('events', { type: 'lead.qualified', id: 'ld_123' })
const sub = store.pubsub.subscribe('events', (msg) => console.log(msg))
sub.close()
```

### Advanced Queue (v2)

```typescript
// Enqueue with options
const job = await store.queueV2.push('scrape-queue', data, {
  priority: 10,       // 1-10, higher = first
  delayMs: 5000,      // run after 5s
  maxAttempts: 5,     // retry up to 5 times
  clientCode: 'ACME', // tenant fairness
})

// Claim next job
const claimed = await store.queueV2.claim<T>('scrape-queue')

// Complete / Fail
await store.queueV2.complete(job.id, result)
await store.queueV2.fail(job.id, 'Something went wrong')

// Progress + Heartbeat
await store.queueV2.updateProgress(job.id, 75)
await store.queueV2.heartbeat(job.id)

// SSE subscription (real-time push)
const sub = store.queueV2.subscribe('scrape-queue', {
  onAdded: (job) => console.log('New job:', job.id),
  onCompleted: (job) => console.log('Done:', job.id),
  onFailed: (job) => console.error('Failed:', job.id),
})
```

### Cache (LRU, tag-based, stale-while-revalidate)

```typescript
await store.cache.set('user:42', userData, { ttl: 3600000, tags: ['users'] })
const cached = await store.cache.get<User>('user:42')
await store.cache.del('user:42')
await store.cache.invalidateByTag('users')
const stats = await store.cache.stats()
```

### Semantic Cache (AI-powered similarity search)

```typescript
await store.semantic.set('faq:pricing', 'What are your pricing plans?', pricingData)
const result = await store.semantic.search('How much does it cost?')
// → { value: pricingData, similarity: 0.97, isExact: false }
```

### Pipeline (batch operations)

```typescript
const results = await store.pipeline([
  { method: 'POST', path: '/core/set', body: { key: 'a', value: '1' } },
  { method: 'POST', path: '/core/set', body: { key: 'b', value: '2' } },
  { method: 'GET', path: '/core/get', params: { key: 'a' } },
])
```

### Cleanup

```typescript
store.close() // Close transport, release resources
```

---

## Worker Package

### Installation

```bash
pnpm add @ecodrix/erix-client @ecodrix/erix-worker
```

### Usage

```typescript
import { ErixClient } from '@ecodrix/erix-client'
import { ErixWorker } from '@ecodrix/erix-worker'

const client = new ErixClient({
  baseUrl: process.env.ERIX_STORE_URL!,
  apiKey: process.env.ERIX_API_KEY!,
  tenantId: 'my-app',
})

const worker = new ErixWorker(client, 'email-queue', async (job) => {
  await sendEmail(job.data.to, job.data.subject)
}, {
  pollIntervalMs: 5000,        // poll every 5s (default)
  maxConcurrentJobs: 10,       // parallel jobs (default)
  heartbeatIntervalMs: 30000,  // heartbeat every 30s (default)
  autoStart: false,            // call worker.run() manually
})

worker.run()

// Graceful shutdown (also handles SIGTERM/SIGINT automatically)
await worker.stop()

// Statistics
const stats = worker.getStats()
// { totalJobsProcessed, successfulJobs, failedJobs, currentConcurrency, isRunning, activeJobs }
```

---

## API Reference

All routes require `x-erix-key` and `x-tenant-id` headers (except `/health`).

### Health

```
GET /health → { status: "ok", uptime: number }
```

### Core (Key/Value)

```
POST /core/set        { key, value, ttl? }
GET  /core/get?key=x  → { value }
DELETE /core/del      { key }
```

### Hash

```
POST /hash/hset              { key, field, value }
GET  /hash/hget?key=x&field=y → { value }
GET  /hash/hgetall?key=x     → { data: Record<string, string> }
```

### List

```
POST /list/lpush  { key, value }
POST /list/rpush  { key, value }
GET  /list/lpop?key=x → { value }
```

### Set

```
POST /set/sadd         { key, value }
GET  /set/smembers?key=x → { members: string[] }
```

### Queue V2

```
POST   /queue/v2/:name/jobs          { data, priority?, delayMs?, maxAttempts?, clientCode? }
POST   /queue/v2/:name/claim         → { job }
POST   /queue/v2/jobs/:id/complete   { result? }
POST   /queue/v2/jobs/:id/fail       { error }
PATCH  /queue/v2/jobs/:id/progress   { progress: 0-100 }
PATCH  /queue/v2/jobs/:id/heartbeat
GET    /queue/v2/jobs/:id            → { job }
GET    /queue/v2/:name/metrics       → { metrics }
GET    /queue/v2/:name/jobs?status=  → { jobs[] }
POST   /queue/v2/jobs/:id/retry
POST   /queue/v2/:name/dlq/retry
DELETE /queue/v2/:name/completed
GET    /queue/v2/:name/events        (SSE stream)
```

### Distributed Locks

```
POST /lock/acquire              { key, ttl, retry?, retryDelay?, autoRenew? } → { token }
POST /lock/release              { key, token }
POST /lock/read/acquire         { key, ttl } → { token }
POST /lock/read/release         { key, token }
POST /lock/write/acquire        { key, ttl } → { token }
POST /lock/write/release        { key, token }
POST /lock/semaphore/acquire    { key, limit, retry? } → { token }
POST /lock/semaphore/release    { key, token }
GET  /lock/:key/status
GET  /lock/all
GET  /lock/deadlocks
DELETE /lock/:key/force
```

### Cache

```
GET    /cache/:key              → { value }
POST   /cache/:key              { value, ttl?, tags?, staleFor? }
DELETE /cache/:key
HEAD   /cache/:key              (existence check)
POST   /cache/mget              { keys: string[] }
POST   /cache/mset              { entries: [{key, value, options?}] }
DELETE /cache/tags/:tag
POST   /cache/tags/invalidate   { tags: string[] }
POST   /cache/pattern/invalidate { pattern }
GET    /cache/_stats
GET    /cache/keys
DELETE /cache/all
```

### Semantic Cache

```
POST   /semantic/:key           { text, value, ttlMs?, tags? }
GET    /semantic/:key           → { value }
POST   /semantic/search         { query, threshold? } → { value, similarity, isExact }
DELETE /semantic/:key
DELETE /semantic/tags/:tag
GET    /semantic/_stats
```

### Rate Limiter

```
POST /ratelimit  { key, limit, window } → { allowed, remaining, resetAt }
```

### Pub/Sub

```
POST /pubsub/publish            { channel, message }
GET  /pubsub/:channel/stream    (SSE stream)
```

### Analytics

```
GET /analytics/usage            → { usage: Record<string, number> }
GET /analytics/anomalies        → { metrics[] }
GET /analytics/anomalies/stream (SSE stream)
```

### Stats

```
GET /stats → { uptime, memory, store }
```

---

## WebSocket Transport

erix-store supports binary WebSocket connections on the same port as HTTP. Frames are encoded with MessagePack for minimal overhead.

### Frame Format

**Request:**
```json
{ "id": 1, "method": "GET", "path": "/core/get", "params": { "key": "foo" } }
```

**Response:**
```json
{ "id": 1, "status": 200, "data": { "value": "bar" } }
```

**Pipeline (batch):**
```json
{ "id": 100, "pipeline": true, "requests": [ ...frames ] }
→ { "id": 100, "pipeline": true, "responses": [ ...responses ] }
```

The client SDK handles this automatically when `transport: 'ws'` or `'auto'` is set.

---

## Multi-Tenant Isolation

The `x-tenant-id` header (or `tenantId` in the client) namespaces all keys server-side. Two tenants with the same key name never collide.

```typescript
// Per-request tenant
const store = new ErixClient({
  baseUrl: process.env.ERIX_STORE_URL!,
  apiKey: process.env.ERIX_API_KEY!,
  tenantId: req.user.orgId,
})
```

---

## Persistence Model

| Layer | Table | Purpose |
|-------|-------|---------|
| Job WAL | `erix_job_wal` | Per-mutation log for zero job loss on crash |
| Snapshots | `erix_snapshots` | Full state dump every 5 minutes (keeps last 5) |
| Usage Events | `erix_usage_events` | Per-tenant metering data |

All tables are auto-created on first boot. No migrations needed.

### WAL Behavior

- Batched writes: buffers up to 100 entries or 50ms, then flushes as a single multi-row INSERT
- On crash: replays surviving jobs from WAL on restart
- Prunes finalized rows older than 24h during each auto-save cycle

---

## Deployment

### Docker (Render, AWS, etc.)

The included `Dockerfile` builds a multi-stage Node.js 20 image. The `render.yaml` provides a one-click Render Blueprint.

```bash
# Build locally
docker build -t erix-store .

# Run
docker run -p 6399:6399 \
  -e DATABASE_URL=postgresql://... \
  -e ERIX_API_KEY=erix_... \
  erix-store
```

### Render deployment

1. Push to GitHub
2. Connect repo on [render.com/blueprints](https://render.com/blueprints)
3. Set environment variables in dashboard
4. Health check path: `/health`

### Cost estimates

| Tier | Render | Database | Total |
|------|--------|----------|-------|
| Dev | Free ($0) | Supabase Free | $0/mo |
| Prod | Starter ($7) | Supabase Pro ($25) | $32/mo |

### Internal networking (recommended for production)

Set erix-store visibility to **Private** on Render. Other services reach it at `http://erix-store:6399` via Render's private network.

---

## Monitoring

### Health check

```bash
curl https://your-erix-store.onrender.com/health
# → { "status": "ok", "uptime": 3421.5 }
```

### Snapshot freshness

```sql
SELECT saved_at, NOW() - saved_at AS age
FROM erix_snapshots
ORDER BY saved_at DESC LIMIT 1;
```

Alert if age > 10 minutes.

### Key log lines to monitor

- `[Persistence] Snapshot saved ✓` — every 5 minutes
- `[BatchedJobWAL] Buffer overflow` — Postgres may be unreachable
- `[Queue] Zombie reaped` — worker heartbeat timeout

---

## Security

| Layer | Mechanism |
|-------|-----------|
| Service auth | `x-erix-key` header on all routes (401 without it) |
| Tenant isolation | `x-tenant-id` header — keys namespaced server-side |
| Data at rest | PostgreSQL with TLS (Supabase/Render enforce by default) |
| Network | Deploy as internal/private service — never expose to internet |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401 Unauthorized` | Wrong/missing `ERIX_API_KEY` | Ensure both services share the same key |
| `400 Missing X-Tenant-Id` | Client not sending `tenantId` | Check `ErixClientOptions.tenantId` |
| Data lost after restart | `DATABASE_URL` not set | Verify DSN and that tables exist |
| Slow responses | Free tier cold starts | Upgrade to Render Starter or add keep-alive ping |
| `EADDRINUSE: 6399` | Port conflict | `kill $(lsof -ti:6399)` or change `PORT` in `.env` |
| Jobs not processing | Worker not running | Check `worker.getStats()` and `client.ping()` |
| Jobs timing out | Long-running without heartbeat | Send `client.queueV2.heartbeat(job.id)` every 15-30s |

---

## Project Structure

```
erix-store/
├── src/
│   ├── index.ts              # Bootstrap + graceful shutdown
│   ├── core/
│   │   ├── Store.ts          # String, Hash, List, Set, SortedSet stores
│   │   ├── Persistence.ts    # Snapshot save/restore
│   │   └── HeapTTLManager.ts # Min-heap TTL expiry
│   ├── server/
│   │   ├── app.ts            # Express routes
│   │   ├── ws.ts             # WebSocket server (MessagePack)
│   │   └── wsRouteHandler.ts # WS → Express bridge
│   ├── services/
│   │   ├── JobQueueV2.ts     # Priority heap queue + tenant fairness
│   │   ├── BatchedJobWAL.ts  # Batched WAL writes
│   │   ├── CacheService.ts   # LRU cache with DLL eviction
│   │   ├── DistributedLock.ts
│   │   ├── PubSub.ts
│   │   ├── RateLimiter.ts
│   │   ├── AnomalyDetector.ts
│   │   ├── SemanticCacheService.ts
│   │   └── UsageMeter.ts
│   └── structures/
│       ├── BinaryHeap.ts     # Generic binary heap
│       ├── SkipList.ts       # O(log n) sorted set
│       ├── LRUList.ts        # DLL + HashMap for O(1) eviction
│       └── SortedSetStore.ts # Skip list-backed sorted sets
├── client/                   # @ecodrix/erix-client (npm package)
│   └── src/
│       ├── index.ts          # ErixClient class
│       └── transports/
│           ├── TransportLayer.ts
│           ├── HttpTransport.ts
│           └── WebSocketTransport.ts
├── worker/                   # @ecodrix/erix-worker (npm package)
│   └── src/index.ts          # ErixWorker class
├── tests/
│   ├── unit/
│   ├── pbt/
│   └── integration/
├── Dockerfile
├── render.yaml
├── vitest.config.ts
└── package.json
```

---

## Development

```bash
# Run tests
pnpm test

# Type check
pnpm type

# Lint + format
pnpm check

# Build all
pnpm build
```

---

## License

MIT
