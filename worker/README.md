# @ecodrix/erix-worker

BullMQ-style worker for **erix-store**. Auto-polling job processor with heartbeat, retry, and graceful shutdown.

## Installation

```bash
pnpm add @ecodrix/erix-client @ecodrix/erix-worker
```

## Usage

### Basic Example

```typescript
import { ErixClient } from '@ecodrix/erix-client'
import { ErixWorker } from '@ecodrix/erix-worker'

// 1. Create client (like Redis)
const client = new ErixClient({
  baseUrl: 'https://erix-store.onrender.com',
  apiKey: process.env.ERIX_API_KEY!,
  tenantId: 'org_abc123',
})

// 2. Create worker (like BullMQ)
const worker = new ErixWorker(client, 'scrape-queue', async (job) => {
  console.log('Processing:', job.data)
  await doWork(job.data)
})

// 3. Start worker
worker.run() // Keeps polling for jobs
```

### Auto-Start Worker

```typescript
const worker = new ErixWorker(client, 'scrape-queue', handler, {
  autoStart: true, // Starts immediately
})
```

### With Options

```typescript
const worker = new ErixWorker(client, 'scrape-queue', handler, {
  pollIntervalMs: 3000,        // Poll every 3 seconds
  maxConcurrentJobs: 5,        // Process 5 jobs at once
  heartbeatIntervalMs: 15000,  // Heartbeat every 15 seconds
  autoStart: true,             // Start immediately
})
```

### Custom Logger

```typescript
import pino from 'pino'

const logger = pino()

const worker = new ErixWorker(client, 'scrape-queue', handler, {
  logger: {
    info: (msg, meta) => logger.info(meta, msg),
    warn: (msg, meta) => logger.warn(meta, msg),
    error: (msg, meta) => logger.error(meta, msg),
  },
})
```

### Graceful Shutdown

```typescript
// Worker automatically handles SIGTERM and SIGINT
// Or manually stop:
await worker.stop()
```

### Worker Statistics

```typescript
const stats = worker.getStats()
console.log(stats)
// {
//   totalJobsProcessed: 42,
//   successfulJobs: 40,
//   failedJobs: 2,
//   currentConcurrency: 3,
//   isRunning: true,
//   activeJobs: 3
// }
```

## How It Works

1. **Polling**: Worker polls `client.queueV2.claim()` every `pollIntervalMs`
2. **Concurrency**: Processes up to `maxConcurrentJobs` simultaneously
3. **Heartbeat**: Sends heartbeat every `heartbeatIntervalMs` to keep jobs alive
4. **Retry**: Failed jobs are automatically retried by erix-store (up to `maxAttempts`)
5. **Graceful Shutdown**: Waits for active jobs to complete (max 30s) before stopping

## Comparison with BullMQ

| Feature | BullMQ | @ecodrix/erix-worker |
|---------|--------|---------------------|
| Queue Backend | Redis | erix-store |
| Worker API | `new Worker(name, handler)` | `new ErixWorker(client, name, handler)` |
| Start Worker | `worker.run()` | `worker.run()` |
| Stop Worker | `worker.close()` | `worker.stop()` |
| Concurrency | ✅ | ✅ |
| Heartbeat | ✅ | ✅ |
| Retry | ✅ | ✅ (handled by erix-store) |
| Priority | ✅ | ✅ |
| Delayed Jobs | ✅ | ✅ |
| Events | ✅ (Redis pub/sub) | ✅ (SSE via `queueV2.subscribe`) |

## Advanced: Event-Driven Worker

Instead of polling, you can use Server-Sent Events (SSE) for real-time job notifications:

```typescript
// Subscribe to queue events
const subscription = client.queueV2.subscribe('scrape-queue', {
  onAdded: async () => {
    // New job added, claim it
    const job = await client.queueV2.claim('scrape-queue')
    if (job) {
      await handler(job)
      await client.queueV2.complete(job.id)
    }
  },
  onError: (err) => console.error(err),
})

// Later: unsubscribe
subscription.close()
```

## License

MIT
