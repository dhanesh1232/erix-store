# ERIX-Store + ERIX-Worker Quick Start Guide

## What is ERIX?

**ERIX** is a complete job queue system that works like **Redis + BullMQ**, but simpler:

- **@ecodrix/erix-client** = Like Redis (queue operations)
- **@ecodrix/erix-worker** = Like BullMQ (job processing)
- **erix-store** = Backend server (like Redis server)

## Installation

```bash
pnpm add @ecodrix/erix-client @ecodrix/erix-worker
```

## Basic Usage

### 1. Create Client (Like Redis)

```typescript
import { ErixClient } from '@ecodrix/erix-client'

const client = new ErixClient({
  baseUrl: 'https://erix-store.onrender.com',
  apiKey: process.env.ERIX_API_KEY!,
  tenantId: 'your-org-id',
})
```

### 2. Enqueue Jobs

```typescript
// Add a job to the queue
await client.queueV2.push('my-queue', {
  task: 'send-email',
  email: 'user@example.com',
  subject: 'Welcome!',
})
```

### 3. Create Worker (Like BullMQ)

```typescript
import { ErixWorker } from '@ecodrix/erix-worker'

const worker = new ErixWorker(client, 'my-queue', async (job) => {
  console.log('Processing:', job.data)
  
  // Do your work here
  await sendEmail(job.data.email, job.data.subject)
  
  console.log('Done!')
})

// Start the worker
worker.run()
```

That's it! The worker will automatically:
- Poll for jobs every 5 seconds
- Process jobs concurrently (up to 10 at once)
- Send heartbeats to keep jobs alive
- Retry failed jobs
- Handle graceful shutdown

## Complete Example

```typescript
import { ErixClient } from '@ecodrix/erix-client'
import { ErixWorker } from '@ecodrix/erix-worker'

// 1. Setup client
const client = new ErixClient({
  baseUrl: 'https://erix-store.onrender.com',
  apiKey: process.env.ERIX_API_KEY!,
  tenantId: 'my-app',
})

// 2. Enqueue some jobs
async function enqueueJobs() {
  await client.queueV2.push('email-queue', {
    to: 'user1@example.com',
    subject: 'Hello!',
  })
  
  await client.queueV2.push('email-queue', {
    to: 'user2@example.com',
    subject: 'Welcome!',
  })
  
  console.log('✅ Jobs enqueued')
}

// 3. Create worker to process jobs
const worker = new ErixWorker(client, 'email-queue', async (job) => {
  console.log(`📧 Sending email to ${job.data.to}`)
  
  // Simulate email sending
  await new Promise(resolve => setTimeout(resolve, 1000))
  
  console.log(`✅ Email sent to ${job.data.to}`)
})

// 4. Start everything
async function main() {
  // Enqueue jobs
  await enqueueJobs()
  
  // Start worker
  worker.run()
  console.log('🚀 Worker started')
}

main()
```

## Advanced Options

### Worker Configuration

```typescript
const worker = new ErixWorker(client, 'my-queue', handler, {
  pollIntervalMs: 3000,        // Poll every 3 seconds (default: 5000)
  maxConcurrentJobs: 5,        // Process 5 jobs at once (default: 10)
  heartbeatIntervalMs: 15000,  // Heartbeat every 15 seconds (default: 30000)
  autoStart: true,             // Start immediately (default: false)
})
```

### Custom Logger

```typescript
import pino from 'pino'

const logger = pino()

const worker = new ErixWorker(client, 'my-queue', handler, {
  logger: {
    info: (msg, meta) => logger.info(meta, msg),
    warn: (msg, meta) => logger.warn(meta, msg),
    error: (msg, meta) => logger.error(meta, msg),
  },
})
```

### Job Options

```typescript
// Priority (higher = processed first)
await client.queueV2.push('my-queue', data, {
  priority: 10,
})

// Delayed job (run in 1 hour)
await client.queueV2.push('my-queue', data, {
  delayMs: 3600000,
})

// Max retry attempts
await client.queueV2.push('my-queue', data, {
  maxAttempts: 5,
})

// Run at specific time
await client.queueV2.push('my-queue', data, {
  runAt: new Date('2024-12-31T23:59:59Z'),
})
```

### Progress Tracking

```typescript
const worker = new ErixWorker(client, 'my-queue', async (job) => {
  // Update progress
  await client.queueV2.updateProgress(job.id, 25)
  await doStep1()
  
  await client.queueV2.updateProgress(job.id, 50)
  await doStep2()
  
  await client.queueV2.updateProgress(job.id, 75)
  await doStep3()
  
  await client.queueV2.updateProgress(job.id, 100)
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

## Event-Driven (Alternative to Polling)

Instead of polling, you can use Server-Sent Events for real-time notifications:

```typescript
// Subscribe to queue events
const subscription = client.queueV2.subscribe('my-queue', {
  onAdded: async (job) => {
    console.log('New job added:', job.id)
    // Claim and process immediately
    const claimed = await client.queueV2.claim('my-queue')
    if (claimed) {
      await handler(claimed)
      await client.queueV2.complete(claimed.id)
    }
  },
  onCompleted: (job) => {
    console.log('Job completed:', job.id)
  },
  onFailed: (job) => {
    console.log('Job failed:', job.id, job.error)
  },
  onError: (err) => {
    console.error('Subscription error:', err)
  },
})

// Later: unsubscribe
subscription.close()
```

## Use Cases

### 1. Email Queue
```typescript
const worker = new ErixWorker(client, 'emails', async (job) => {
  await sendEmail(job.data.to, job.data.subject, job.data.body)
})
worker.run()
```

### 2. Image Processing
```typescript
const worker = new ErixWorker(client, 'images', async (job) => {
  const image = await downloadImage(job.data.url)
  const resized = await resizeImage(image, 800, 600)
  await uploadImage(resized, job.data.destination)
})
worker.run()
```

### 3. Web Scraping
```typescript
const worker = new ErixWorker(client, 'scraping', async (job) => {
  const data = await scrapeWebsite(job.data.url)
  await saveToDatabase(data)
})
worker.run()
```

### 4. Report Generation
```typescript
const worker = new ErixWorker(client, 'reports', async (job) => {
  const data = await fetchData(job.data.filters)
  const pdf = await generatePDF(data)
  await emailReport(job.data.email, pdf)
})
worker.run()
```

## Comparison with BullMQ

| Feature | BullMQ | ERIX |
|---------|--------|------|
| Backend | Redis | erix-store |
| Client | `new Queue()` | `new ErixClient()` |
| Worker | `new Worker()` | `new ErixWorker()` |
| Enqueue | `queue.add()` | `client.queueV2.push()` |
| Process | `worker.run()` | `worker.run()` |
| Priority | ✅ | ✅ |
| Delayed Jobs | ✅ | ✅ |
| Retry | ✅ | ✅ |
| Progress | ✅ | ✅ |
| Events | ✅ | ✅ (SSE) |
| Concurrency | ✅ | ✅ |
| Heartbeat | ✅ | ✅ |

## Environment Variables

```bash
# Required
ERIX_STORE_URL=https://erix-store.onrender.com
ERIX_API_KEY=your-api-key-here
ERIX_TENANT_ID=your-org-id
```

## Deployment

### Development
```bash
pnpm dev
```

### Production
```bash
pnpm build
pnpm start
```

The worker starts automatically with your application - no separate deployment needed!

## Troubleshooting

### Jobs Not Processing
1. Check worker is running: `worker.getStats()`
2. Check jobs are enqueued: `await client.queueV2.get(jobId)`
3. Check erix-store is reachable: `await client.ping()`

### High Memory Usage
1. Reduce `maxConcurrentJobs`
2. Check for memory leaks in job handlers
3. Monitor with `worker.getStats()`

### Jobs Timing Out
1. Increase `heartbeatIntervalMs`
2. Send manual heartbeats in long-running jobs:
   ```typescript
   await client.queueV2.heartbeat(job.id)
   ```

## Best Practices

1. **Use Heartbeats**: For jobs longer than 30 seconds, send heartbeats
2. **Handle Errors**: Wrap job logic in try-catch
3. **Set Priorities**: Use priority for important jobs
4. **Monitor Stats**: Check `worker.getStats()` regularly
5. **Graceful Shutdown**: Always call `worker.stop()` on shutdown
6. **Use Progress**: Update progress for long-running jobs
7. **Set Max Attempts**: Limit retries to prevent infinite loops

## Examples Repository

Check out the examples in:
- `ECOD/server/src/lib/laie/` - Real-world usage
- `ECOD/server/scripts/test-session-isolation.ts` - Testing example

## Support

- Documentation: See `ERIX-WORKER-PACKAGE.md`
- Issues: GitHub Issues
- Email: contact@ecodrix.com

## License

MIT
