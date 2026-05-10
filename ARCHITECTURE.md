# ERIX Architecture - Complete System

## Overview

ERIX is a complete job queue system that works like Redis + BullMQ, but simpler and more integrated.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ERIX Ecosystem                               │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    User Applications                          │  │
│  │                                                               │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │  │
│  │  │   ECOD/server   │  │  Other Project  │  │  Your App    │ │  │
│  │  │                 │  │                 │  │              │ │  │
│  │  │  ┌───────────┐  │  │  ┌───────────┐  │  │ ┌──────────┐│ │  │
│  │  │  │ErixClient │  │  │  │ErixClient │  │  │ │ErixClient││ │  │
│  │  │  └─────┬─────┘  │  │  └─────┬─────┘  │  │ └────┬─────┘│ │  │
│  │  │        │        │  │        │        │  │      │      │ │  │
│  │  │  ┌─────▼─────┐  │  │  ┌─────▼─────┐  │  │ ┌────▼─────┐│ │  │
│  │  │  │ErixWorker │  │  │  │ErixWorker │  │  │ │ErixWorker││ │  │
│  │  │  └───────────┘  │  │  └───────────┘  │  │ └──────────┘│ │  │
│  │  └─────────────────┘  └─────────────────┘  └──────────────┘ │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                │                                    │
│                                │ HTTP/WebSocket                     │
│                                ▼                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    ERIX-Store Server                          │  │
│  │                  (Queue Backend Service)                      │  │
│  │                                                               │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐            │  │
│  │  │   Queue    │  │   Cache    │  │  PubSub    │            │  │
│  │  │  Manager   │  │  Manager   │  │  Manager   │            │  │
│  │  └────────────┘  └────────────┘  └────────────┘            │  │
│  │                                                               │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐            │  │
│  │  │ Rate Limit │  │ Analytics  │  │  Semantic  │            │  │
│  │  │  Manager   │  │  Manager   │  │   Cache    │            │  │
│  │  └────────────┘  └────────────┘  └────────────┘            │  │
│  │                                                               │  │
│  │                        ┌──────────┐                          │  │
│  │                        │PostgreSQL│                          │  │
│  │                        └──────────┘                          │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Package Structure

```
@ecodrix/erix-client (like Redis client)
├── Core Operations
│   ├── set(key, value, ttl)
│   ├── get(key)
│   └── del(key)
├── Hash Operations
│   ├── hset(key, field, value)
│   ├── hget(key, field)
│   └── hgetall(key)
├── List Operations
│   ├── lpush(key, value)
│   ├── rpush(key, value)
│   └── lpop(key)
├── Queue Operations (v2)
│   ├── push(queue, data, options)
│   ├── claim(queue)
│   ├── complete(jobId, result)
│   ├── fail(jobId, error)
│   ├── updateProgress(jobId, progress)
│   ├── heartbeat(jobId)
│   ├── get(jobId)
│   └── subscribe(queue, handlers)
├── Cache Operations
│   ├── get(key)
│   ├── set(key, value, options)
│   ├── del(key)
│   ├── invalidateByTag(tag)
│   └── stats()
├── Semantic Cache
│   ├── set(key, text, value, ttl, tags)
│   ├── get(key)
│   ├── search(query, threshold)
│   └── invalidateByTag(tag)
├── PubSub
│   ├── publish(channel, message)
│   └── subscribe(channel, onMessage)
├── Rate Limiting
│   └── rateLimit(key, limit, window)
└── Analytics
    ├── usage()
    ├── anomalies()
    └── subscribeAlerts(onAlert)

@ecodrix/erix-worker (like BullMQ)
├── Worker Class
│   ├── constructor(client, queueName, handler, options)
│   ├── run()
│   ├── stop()
│   └── getStats()
├── Features
│   ├── Auto-polling (configurable interval)
│   ├── Concurrency control (max concurrent jobs)
│   ├── Heartbeat system (keep jobs alive)
│   ├── Graceful shutdown (SIGTERM/SIGINT)
│   ├── Error handling (automatic retry)
│   └── Statistics tracking
└── Options
    ├── pollIntervalMs (default: 5000)
    ├── maxConcurrentJobs (default: 10)
    ├── heartbeatIntervalMs (default: 30000)
    ├── autoStart (default: false)
    └── logger (default: console)
```

## Data Flow

### 1. Enqueue Job

```
User App
   │
   │ client.queueV2.push('queue-name', data)
   │
   ▼
ErixClient
   │
   │ POST /queue/v2/:queueName/jobs
   │
   ▼
ERIX-Store
   │
   │ Create job with status='waiting'
   │ Store in PostgreSQL
   │ Emit 'job:added' event (SSE)
   │
   ▼
Job Queue
```

### 2. Process Job

```
ErixWorker
   │
   │ Poll every 5 seconds
   │
   ▼
ErixClient
   │
   │ client.queueV2.claim('queue-name')
   │
   ▼
ERIX-Store
   │
   │ Find next eligible job
   │ Update status='active'
   │ Return job to worker
   │
   ▼
ErixWorker
   │
   │ Execute handler(job)
   │ Send heartbeat every 30s
   │
   ▼
Handler
   │
   │ Process job data
   │ Update progress (optional)
   │
   ▼
ErixWorker
   │
   │ client.queueV2.complete(jobId)
   │
   ▼
ERIX-Store
   │
   │ Update status='completed'
   │ Store result
   │ Emit 'job:completed' event
   │
   ▼
Job Complete
```

### 3. Error Handling

```
Handler
   │
   │ throw new Error('Failed')
   │
   ▼
ErixWorker
   │
   │ Catch error
   │ client.queueV2.fail(jobId, error)
   │
   ▼
ERIX-Store
   │
   │ Increment attempts
   │ If attempts < maxAttempts:
   │   └─> Update status='waiting' (retry)
   │ Else:
   │   └─> Update status='failed' (permanent)
   │
   ▼
Job Failed or Retried
```

## Comparison with Redis + BullMQ

### Redis + BullMQ Architecture

```
┌─────────────────────────────────────────┐
│          User Application                │
│                                          │
│  ┌──────────┐      ┌──────────────┐    │
│  │  Queue   │      │    Worker    │    │
│  │(BullMQ)  │      │   (BullMQ)   │    │
│  └────┬─────┘      └──────┬───────┘    │
│       │                   │             │
└───────┼───────────────────┼─────────────┘
        │                   │
        └─────────┬─────────┘
                  │
                  ▼
        ┌─────────────────┐
        │  Redis Server   │
        │  (Separate)     │
        └─────────────────┘
```

**Complexity**: High
- Need to install and manage Redis
- Need to install BullMQ
- Two separate systems to maintain

### ERIX Architecture

```
┌─────────────────────────────────────────┐
│          User Application                │
│                                          │
│  ┌──────────┐      ┌──────────────┐    │
│  │ErixClient│      │  ErixWorker  │    │
│  └────┬─────┘      └──────┬───────┘    │
│       │                   │             │
└───────┼───────────────────┼─────────────┘
        │                   │
        └─────────┬─────────┘
                  │
                  ▼
        ┌─────────────────┐
        │  ERIX-Store     │
        │  (All-in-one)   │
        └─────────────────┘
```

**Complexity**: Low
- Single service (ERIX-Store)
- Two packages (client + worker)
- Integrated system

## Feature Comparison

| Feature | Redis + BullMQ | ERIX |
|---------|---------------|------|
| **Setup** | Install Redis + BullMQ | Install ERIX packages |
| **Backend** | Redis (separate) | ERIX-Store (integrated) |
| **Client** | `new Queue()` | `new ErixClient()` |
| **Worker** | `new Worker()` | `new ErixWorker()` |
| **Queue** | ✅ | ✅ |
| **Cache** | ✅ (Redis) | ✅ (Built-in) |
| **PubSub** | ✅ (Redis) | ✅ (Built-in) |
| **Rate Limit** | ❌ (Need separate) | ✅ (Built-in) |
| **Analytics** | ❌ (Need separate) | ✅ (Built-in) |
| **Semantic Cache** | ❌ | ✅ (Built-in) |
| **Priority** | ✅ | ✅ |
| **Delayed Jobs** | ✅ | ✅ |
| **Retry** | ✅ | ✅ |
| **Progress** | ✅ | ✅ |
| **Heartbeat** | ✅ | ✅ |
| **Events** | ✅ (Redis pub/sub) | ✅ (SSE) |
| **TypeScript** | ✅ | ✅ |
| **Persistence** | ✅ (Redis AOF/RDB) | ✅ (PostgreSQL) |
| **Scalability** | ✅ (Redis Cluster) | ✅ (Horizontal) |

## Use Cases

### 1. Background Jobs
```typescript
// Email sending, report generation, data processing
const worker = new ErixWorker(client, 'jobs', async (job) => {
  await processJob(job.data)
})
worker.run()
```

### 2. Web Scraping
```typescript
// Scrape websites with session isolation
const worker = new ErixWorker(client, 'scraping', async (job) => {
  const data = await scrapeWebsite(job.data.url)
  await saveToDatabase(data)
})
worker.run()
```

### 3. Image Processing
```typescript
// Resize, compress, convert images
const worker = new ErixWorker(client, 'images', async (job) => {
  const processed = await processImage(job.data.url)
  await uploadToS3(processed)
})
worker.run()
```

### 4. Scheduled Tasks
```typescript
// Run tasks at specific times
await client.queueV2.push('tasks', data, {
  runAt: new Date('2024-12-31T23:59:59Z')
})
```

### 5. Priority Queue
```typescript
// Process high-priority jobs first
await client.queueV2.push('queue', data, {
  priority: 10 // Higher = processed first
})
```

## Deployment Options

### 1. Single Server (Development)
```
┌─────────────────────────┐
│   Single Server         │
│                         │
│  ┌──────────────────┐   │
│  │  Your App        │   │
│  │  + ErixWorker    │   │
│  └──────────────────┘   │
│           │             │
│           ▼             │
│  ┌──────────────────┐   │
│  │  ERIX-Store      │   │
│  └──────────────────┘   │
└─────────────────────────┘
```

### 2. Separate Services (Production)
```
┌──────────────┐     ┌──────────────┐
│   Web App    │     │   Workers    │
│              │     │              │
│ ErixClient   │     │ ErixWorker   │
└──────┬───────┘     └──────┬───────┘
       │                    │
       └──────────┬─────────┘
                  │
                  ▼
         ┌────────────────┐
         │  ERIX-Store    │
         │  (Render/AWS)  │
         └────────────────┘
```

### 3. Microservices (Scale)
```
┌─────────┐  ┌─────────┐  ┌─────────┐
│Service 1│  │Service 2│  │Service 3│
│+Worker  │  │+Worker  │  │+Worker  │
└────┬────┘  └────┬────┘  └────┬────┘
     │            │            │
     └────────────┼────────────┘
                  │
                  ▼
         ┌────────────────┐
         │  ERIX-Store    │
         │  (Centralized) │
         └────────────────┘
```

## Performance

### Throughput
- **Jobs/second**: 100-1000 (depends on job complexity)
- **Concurrent workers**: Unlimited (horizontal scaling)
- **Concurrent jobs per worker**: Configurable (default: 10)

### Latency
- **Enqueue**: < 10ms
- **Claim**: < 20ms
- **Complete**: < 10ms
- **Polling interval**: 5s (configurable)

### Scalability
- **Horizontal**: Add more workers
- **Vertical**: Increase `maxConcurrentJobs`
- **Database**: PostgreSQL (proven scalability)

## Security

### Authentication
- API Key authentication
- Tenant isolation
- Per-tenant rate limiting

### Data Protection
- HTTPS/TLS encryption
- Secure token storage
- Environment variable configuration

## Monitoring

### Worker Statistics
```typescript
const stats = worker.getStats()
// {
//   totalJobsProcessed: 42,
//   successfulJobs: 40,
//   failedJobs: 2,
//   currentConcurrency: 3,
//   isRunning: true,
//   activeJobs: 3
// }
```

### Queue Analytics
```typescript
const usage = await client.analytics.usage()
// {
//   'queue:push': 1000,
//   'queue:claim': 950,
//   'queue:complete': 900,
//   'queue:fail': 50
// }
```

### Anomaly Detection
```typescript
const subscription = client.analytics.subscribeAlerts((alert) => {
  console.log(`ALERT: ${alert.message}`)
  // Alert: queue:fail exceeded 3σ threshold
})
```

## Summary

ERIX provides a complete, integrated job queue system that:

1. ✅ Works like Redis + BullMQ (familiar API)
2. ✅ Simpler setup (single service)
3. ✅ More features (cache, pubsub, analytics, etc.)
4. ✅ Production ready (heartbeat, retry, monitoring)
5. ✅ Type safe (full TypeScript support)
6. ✅ Scalable (horizontal + vertical)
7. ✅ Secure (authentication + isolation)

**Perfect for modern applications that need reliable background job processing!**
