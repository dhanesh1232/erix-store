# erix-store — Production Usage Guide

> **What is erix-store?**  
> A single-threaded, in-memory data store modeled after Redis — purpose-built for the ECODrIx platform. It runs as a sidecar HTTP service and provides key/value storage, hashes, lists, queues, pub/sub, rate limiting, and distributed locking. State is snapshotted to PostgreSQL every 5 minutes so restarts don't lose data.

---

## Table of Contents

1. [Deploying to Render](#1-deploying-to-render)
2. [Environment Variables](#2-environment-variables)
3. [Connecting from Another Service](#3-connecting-from-another-service)
4. [Using the Client Package](#4-using-the-client-package)
5. [API Reference](#5-api-reference)
6. [Multi-Tenant Usage](#6-multi-tenant-usage)
7. [Rate Limiting Patterns](#7-rate-limiting-patterns)
8. [Queue Patterns](#8-queue-patterns)
9. [Caching Patterns](#9-caching-patterns)
10. [Health & Monitoring](#10-health--monitoring)
11. [Security Model](#11-security-model)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Deploying to Render

### One-click deploy via render.yaml

The `render.yaml` in the root of this repository is a Render Blueprint. Push the repo to GitHub and connect it on [render.com/blueprints](https://render.com/blueprints).

### Manual deploy

1. **Create a new Web Service** on Render
2. Set **Runtime** → Docker
3. Set **Dockerfile path** → `./Dockerfile`
4. Set **Health Check Path** → `/health`
5. Set these Environment Variables (see next section)
6. Deploy

After deploy, your service URL will be something like:
```
https://erix-store.onrender.com
```

---

## 2. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL DSN for snapshot persistence. Supabase, Neon, or Render Postgres all work. |
| `ERIX_API_KEY` | ✅ | Shared secret — every client must send this in the `x-erix-key` header. |
| `PORT` | ✅ | Port to listen on. Render injects this automatically; default is `6399`. |
| `NODE_ENV` | — | Set to `production` on Render for cleaner logs. |

### Generating an API key

```bash
node -e "console.log('erix_' + require('crypto').randomBytes(32).toString('hex'))"
```

Set the **same value** in:
- Render dashboard → erix-store → `ERIX_API_KEY`  
- Every consuming service's env → `ERIX_STORE_API_KEY` (or however you name it)

### PostgreSQL setup

Run this once against your database to create the snapshot table (erix-store creates it automatically on first boot, but you can also create it manually):

```sql
CREATE TABLE IF NOT EXISTS erix_snapshots (
  id        SERIAL PRIMARY KEY,
  label     TEXT NOT NULL UNIQUE,
  data      JSONB NOT NULL,
  saved_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 3. Connecting from Another Service

You don't need to know anything about the HTTP API. Use the client package (next section) or configure the URL + key as environment variables in your service:

```env
# In your server/.env
ERIX_STORE_URL=https://erix-store.onrender.com
ERIX_STORE_API_KEY=erix_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 4. Using the Client Package

The `client/` directory is a self-contained, publishable npm package. It uses native `fetch` — **no extra dependencies**.

### Option A — Copy the client into your project

```bash
# From your project root
cp -r /path/to/erix-store/client/src/index.ts src/lib/erixClient.ts
```

### Option B — Publish to npm (or a private registry)

```bash
cd client/
npm install
npm run build
npm publish --access public        # or --registry https://your-private-registry
```

Then install in other services:

```bash
npm install @ecodrix/erix-client
```

### Option C — Use as a local path dependency

In your consuming project's `package.json`:

```json
{
  "dependencies": {
    "@ecodrix/erix-client": "file:../../erix-store/client"
  }
}
```

---

### Initializing the client

```ts
import { ErixClient } from '@ecodrix/erix-client'
// or: import { ErixClient } from './lib/erixClient'

const store = new ErixClient({
  baseUrl: process.env.ERIX_STORE_URL!,     // https://erix-store.onrender.com
  apiKey:  process.env.ERIX_STORE_API_KEY!, // erix_xxxxx
  tenantId: 'org_abc123',                   // your org / workspace ID
  timeoutMs: 5000,                          // optional, default 5s
})
```

> **`tenantId` is the namespace.** All keys are automatically prefixed with `tenantId:` on the server. Two tenants with the same key name never collide. You never see this prefix in client code.

---

## 5. API Reference

### Key / Value

```ts
// Set a value (with optional TTL in seconds)
await store.set('user:42', { name: 'Dhanesh', role: 'admin' })
await store.set('session:abc', token, 3600)   // expires in 1 hour

// Get a value (returns null if missing or expired)
const user = await store.get<User>('user:42')

// Delete a key
await store.del('session:abc')
```

---

### Hash (like a nested object / document)

```ts
// Set individual fields
await store.hash.hset('org:123:settings', 'theme', 'dark')
await store.hash.hset('org:123:settings', 'language', 'en')

// Get one field
const theme = await store.hash.hget<string>('org:123:settings', 'theme')

// Get all fields at once
const settings = await store.hash.hgetall('org:123:settings')
// → { theme: 'dark', language: 'en' }
```

---

### List (ordered collection)

```ts
// Add items
await store.list.rpush('notifications:user1', { type: 'alert', msg: 'Login detected' })
await store.list.lpush('notifications:user1', { type: 'urgent', msg: 'Password changed' })

// Remove from the front (FIFO)
const next = await store.list.lpop<Notification>('notifications:user1')
```

---

### Queue (FIFO job queue, built on List)

```ts
// Producer — enqueue a job
await store.queue.push('email-send', {
  to: 'user@example.com',
  template: 'welcome',
  vars: { name: 'Dhanesh' }
})

// Consumer — dequeue (returns null when queue is empty)
const job = await store.queue.pop<EmailJob>('email-send')
if (job) {
  await sendEmail(job)
}
```

---

### Rate Limiter

```ts
const result = await store.rateLimit(
  `api:${orgId}`,   // key
  100,              // limit: max 100 requests
  60,               // window: per 60 seconds
)

if (!result.allowed) {
  throw new Error(`Rate limit exceeded. Resets in ${result.resetAt - Date.now()}ms`)
}
```

---

### PubSub

```ts
// Publish an event (fire and forget)
await store.pubsub.publish('lead:qualified', { leadId: 'ld_123', score: 92 })
```

> **Note:** Subscribe is handled via webhooks or SSE on the consuming service side. erix-store's pubsub is currently single-direction (publish only via HTTP). Full bi-directional subscribe support is on the roadmap.

---

### Set

```ts
// Add unique members
await store.set_.sadd('active-sessions', 'session:abc')
await store.set_.sadd('active-sessions', 'session:xyz')

// Get all members
const sessions = await store.set_.smembers('active-sessions')
// → ['session:abc', 'session:xyz']
```

---

### Health check

```ts
const health = await store.ping()
// → { status: 'ok', uptime: 3421.5 }
```

---

## 6. Multi-Tenant Usage

The `tenantId` you pass at construction is the isolation boundary. You can instantiate multiple clients with different tenant IDs in the same service:

```ts
const orgStore = new ErixClient({
  baseUrl: process.env.ERIX_STORE_URL!,
  apiKey: process.env.ERIX_STORE_API_KEY!,
  tenantId: req.user.orgId,   // ← per-request tenant
})
```

Or create a factory:

```ts
// lib/store.ts
import { ErixClient } from '@ecodrix/erix-client'

export const getStore = (orgId: string) =>
  new ErixClient({
    baseUrl: process.env.ERIX_STORE_URL!,
    apiKey:  process.env.ERIX_STORE_API_KEY!,
    tenantId: orgId,
  })
```

```ts
// In your route handler
const store = getStore(req.user.orgId)
const plan = await store.get<OrgPlan>('plan:active')
```

---

## 7. Rate Limiting Patterns

### Per-endpoint rate limit

```ts
async function apiHandler(req: Request, res: Response) {
  const { allowed, remaining } = await store.rateLimit(
    `${req.user.orgId}:${req.path}`,
    50,   // 50 requests
    60,   // per minute
  )

  res.setHeader('X-RateLimit-Remaining', remaining)
  if (!allowed) return res.status(429).json({ error: 'Too many requests' })

  // ... handle request
}
```

### Per-user rate limit for AI calls

```ts
const { allowed } = await store.rateLimit(
  `ai-calls:${userId}`,
  10,    // 10 AI calls
  3600,  // per hour
)
```

---

## 8. Queue Patterns

### Worker loop (polling)

```ts
// worker.ts — runs as a background process
while (true) {
  const job = await store.queue.pop<ProcessLeadJob>('process-lead')

  if (!job) {
    await sleep(500)   // back-off when queue is empty
    continue
  }

  try {
    await processLead(job)
  } catch (err) {
    // Re-enqueue with error metadata for retry
    await store.queue.push('process-lead:dlq', { ...job, error: String(err) })
  }
}
```

### Dead-letter queue (DLQ)

```ts
// Enqueue with retry count
await store.queue.push('send-webhook', { url, payload, attempt: 0 })

// In worker — re-enqueue up to 3 times
const job = await store.queue.pop<WebhookJob>('send-webhook')
if (job) {
  try {
    await sendWebhook(job.url, job.payload)
  } catch {
    if (job.attempt < 3) {
      await store.queue.push('send-webhook', { ...job, attempt: job.attempt + 1 })
    } else {
      await store.queue.push('send-webhook:failed', job)
    }
  }
}
```

---

## 9. Caching Patterns

### Cache-aside (read-through)

```ts
async function getOrgPlan(orgId: string): Promise<OrgPlan> {
  const cached = await store.get<OrgPlan>(`plan:${orgId}`)
  if (cached) return cached

  const plan = await db.plans.findOne({ orgId })
  await store.set(`plan:${orgId}`, plan, 300)  // cache for 5 minutes
  return plan
}
```

### Invalidate on write

```ts
async function updatePlan(orgId: string, updates: Partial<OrgPlan>) {
  await db.plans.update({ orgId }, updates)
  await store.del(`plan:${orgId}`)   // bust cache
}
```

### Session storage

```ts
// Store session on login (24hr expiry)
await store.set(`session:${sessionId}`, { userId, orgId, role }, 86400)

// Read session on every request
const session = await store.get<Session>(`session:${sessionId}`)
if (!session) throw new Error('Session expired')
```

---

## 10. Health & Monitoring

### Health endpoint

```
GET https://erix-store.onrender.com/health
→ { "status": "ok", "uptime": 3421.5 }
```

No auth required — safe to poll from a load balancer or uptime monitor.

### Stats endpoint (auth required)

```
GET https://erix-store.onrender.com/stats
Headers: x-erix-key: <ERIX_API_KEY>
         x-tenant-id: <any>
→ { uptime, memory, store }
```

### Snapshot status

erix-store saves a full snapshot to PostgreSQL every 5 minutes. The `erix_snapshots` table has a `saved_at` column — alert if it falls more than 10 minutes behind.

```sql
SELECT saved_at, NOW() - saved_at AS age
FROM erix_snapshots
WHERE label = 'main'
ORDER BY saved_at DESC
LIMIT 1;
```

---

## 11. Security Model

| Layer | Mechanism |
|---|---|
| **Service-to-service auth** | `x-erix-key` header — all authenticated routes 401 without it |
| **Tenant isolation** | `x-tenant-id` header — keys are namespaced server-side, impossible to access cross-tenant |
| **Snapshot at rest** | PostgreSQL with TLS — Supabase/Render Postgres enforce TLS by default |
| **Network** | Run erix-store as an internal Render service (private networking) so it's never directly exposed to the internet |

### Making erix-store internal-only on Render

In the Render dashboard → erix-store → Settings:
- Set **Visibility** to **Private** (internal service)
- Your other Render services reach it at `http://erix-store:6399` via Render's private network — no internet exposure, no latency penalty

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | Wrong or missing `ERIX_API_KEY` | Ensure both services have the same key value |
| `400 Missing X-Tenant-Id` | Client not sending `tenantId` | Check `ErixClientOptions.tenantId` is set |
| Slow responses | erix-store is on Render free tier (cold starts) | Upgrade to Render Starter ($7/mo) or use a keep-alive ping |
| Data lost after restart | `DATABASE_URL` not set or wrong | Verify the Supabase DSN and that `erix_snapshots` table exists |
| `EADDRINUSE: 6399` | Port conflict locally | `kill $(lsof -ti:6399)` or set `PORT=6399` in `.env` |
| `fetch failed` / timeout | erix-store unreachable | Check `ERIX_STORE_URL` has no trailing slash; verify service is running |
