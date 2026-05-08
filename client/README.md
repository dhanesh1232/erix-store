# @ecodrix/erix-client

Type-safe HTTP client for [erix-store](../README.md) — the ECODrIx in-memory data sidecar.

**Zero extra dependencies.** Uses native `fetch` (Node 18+).

## Install

```bash
npm install @ecodrix/erix-client
# or: copy client/src/index.ts directly into your project
```

## Quick start

```ts
import { ErixClient } from '@ecodrix/erix-client'

const store = new ErixClient({
  baseUrl:  process.env.ERIX_STORE_URL!,      // https://erix-store.onrender.com
  apiKey:   process.env.ERIX_STORE_API_KEY!,  // erix_xxxxxxxxxxxxxxxx
  tenantId: req.user.orgId,                   // your tenant namespace
})

// Key / Value
await store.set('user:42', { name: 'Dhanesh' }, 3600)  // TTL optional
const user = await store.get<User>('user:42')

// Queue
await store.queue.push('send-email', { to: 'a@b.com', template: 'welcome' })
const job = await store.queue.pop<EmailJob>('send-email')

// Rate limiter
const { allowed } = await store.rateLimit(`api:${orgId}`, 100, 60)

// Hash
await store.hash.hset('settings:org1', 'theme', 'dark')
const theme = await store.hash.hget<string>('settings:org1', 'theme')

// Health
const { status } = await store.ping()
```

See [PRODUCTION.md](../PRODUCTION.md) for full patterns, multi-tenant setup, and troubleshooting.

## API

| Method | Description |
|---|---|
| `store.set(key, value, ttl?)` | Store a JSON value with optional TTL in seconds |
| `store.get<T>(key)` | Retrieve value or `null` if missing/expired |
| `store.del(key)` | Delete a key |
| `store.hash.hset(key, field, value)` | Set a hash field |
| `store.hash.hget<T>(key, field)` | Get one hash field |
| `store.hash.hgetall(key)` | Get all fields of a hash |
| `store.list.lpush(key, value)` | Prepend to a list |
| `store.list.rpush(key, value)` | Append to a list |
| `store.list.lpop<T>(key)` | Pop from list front |
| `store.queue.push(name, data)` | Enqueue a job |
| `store.queue.pop<T>(name)` | Dequeue a job (`null` if empty) |
| `store.pubsub.publish(channel, msg)` | Publish an event |
| `store.rateLimit(key, limit, window)` | Check rate limit |
| `store.set_.sadd(key, member)` | Add to a set |
| `store.set_.smembers(key)` | Get all set members |
| `store.ping()` | Health check |
