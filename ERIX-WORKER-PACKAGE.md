# ERIX-Worker Package - Complete Implementation

## Overview

We've successfully created **@ecodrix/erix-worker**, a BullMQ-style worker package for erix-store. This package allows users to import and use workers directly, just like how Redis and BullMQ work together.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    User Application                         │
│  ┌────────────────────┐      ┌──────────────────────┐       │
│  │  @ecodrix/         │      │  @ecodrix/           │       │
│  │  erix-client       │      │  erix-worker         │       │
│  │  (like Redis)      │      │  (like BullMQ)       │       │
│  └────────────────────┘      └──────────────────────┘       │
│           │                            │                    │
│           └────────────┬───────────────┘                    │
│                        │                                    │
└────────────────────────┼────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   ERIX-Store Server  │
              │  (Queue Backend)     │
              └──────────────────────┘
```

## Package Structure

```
ECOD/erix-store/
├── client/                    # @ecodrix/erix-client (like Redis)
│   ├── src/
│   │   └── index.ts          # ErixClient implementation
│   ├── package.json
│   └── tsconfig.json
├── worker/                    # @ecodrix/erix-worker (like BullMQ)
│   ├── src/
│   │   └── index.ts          # ErixWorker implementation
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md
├── pnpm-workspace.yaml       # Workspace configuration
└── package.json              # Root package
```

## Usage Example

### In Your Application (e.g., ECOD/server)

```typescript
import { ErixClient } from '@ecodrix/erix-client'
import { ErixWorker } from '@ecodrix/erix-worker'

// 1. Create client (like Redis)
const client = new ErixClient({
  baseUrl: 'https://erix-store.onrender.com',
  apiKey: process.env.ERIX_API_KEY!,
  tenantId: 'org_abc123',
})

// 2. Enqueue jobs
await client.queueV2.push('scrape-queue', {
  actor: 'google-maps',
  input: { query: 'restaurants in NYC' }
})

// 3. Create worker (like BullMQ)
const worker = new ErixWorker(client, 'scrape-queue', async (job) => {
  console.log('Processing:', job.data)
  await executeActor(job.data)
})

// 4. Start worker
worker.run() // Keeps polling for jobs
```

## Key Features

### 1. **BullMQ-Style API**
- `new ErixWorker(client, queueName, handler, options)`
- `worker.run()` - Start polling
- `worker.stop()` - Graceful shutdown
- `worker.getStats()` - Get statistics

### 2. **Auto-Polling**
- Polls `client.queueV2.claim()` every `pollIntervalMs` (default: 5000ms)
- Respects concurrency limits (`maxConcurrentJobs`)
- Automatic retry on failure (handled by erix-store)

### 3. **Heartbeat System**
- Sends heartbeat every `heartbeatIntervalMs` (default: 30000ms)
- Keeps jobs alive during long-running operations
- Prevents zombie jobs (reaper system in erix-store)

### 4. **Graceful Shutdown**
- Handles SIGTERM and SIGINT automatically
- Waits for active jobs to complete (max 30 seconds)
- Cleans up resources properly

### 5. **Statistics**
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

## Implementation in ECOD/server

### Before (Local Implementation)
```typescript
// ECOD/server/src/lib/laie/erixWorker.ts
import { createErixWorker } from './erixWorker'

const worker = createErixWorker('laie-scrapers', handler)
worker.run()
```

### After (Using Package)
```typescript
// ECOD/server/src/lib/laie/index.ts
import { ErixClient } from '@ecodrix/erix-client'
import { ErixWorker } from '@ecodrix/erix-worker'

const client = new ErixClient({
  baseUrl: process.env.ERIX_STORE_URL,
  apiKey: process.env.ERIX_API_KEY,
  tenantId: process.env.ERIX_TENANT_ID,
})

const worker = new ErixWorker(client, 'laie-scrapers', handler, {
  pollIntervalMs: 5000,
  maxConcurrentJobs: 10,
  heartbeatIntervalMs: 30000,
})

worker.run()
```

## Configuration Options

```typescript
interface ErixWorkerOptions {
  pollIntervalMs?: number;        // Default: 5000
  maxConcurrentJobs?: number;     // Default: 10
  heartbeatIntervalMs?: number;   // Default: 30000
  autoStart?: boolean;            // Default: false
  logger?: WorkerLogger;          // Default: console
}
```

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

## Files Modified

### New Files Created
1. `ECOD/erix-store/worker/src/index.ts` - Worker implementation
2. `ECOD/erix-store/worker/package.json` - Package configuration
3. `ECOD/erix-store/worker/tsconfig.json` - TypeScript configuration
4. `ECOD/erix-store/worker/README.md` - Package documentation
5. `ECOD/erix-store/pnpm-workspace.yaml` - Workspace configuration

### Files Updated
1. `ECOD/server/src/lib/laie/index.ts` - Updated to use new packages
2. `ECOD/server/package.json` - Added `@ecodrix/erix-worker` dependency

### Files to Remove (Optional)
1. `ECOD/server/src/lib/laie/erixWorker.ts` - No longer needed (logic moved to package)

## Build & Publish

### Build Worker Package
```bash
pnpm --filter @ecodrix/erix-worker build
```

### Publish to npm
```bash
cd ECOD/erix-store/worker
pnpm publish --access public
```

### Update Client Package Version
```bash
cd ECOD/erix-store/client
# Update version in package.json
pnpm publish --access public
```

## Testing

### Test in Server
```bash
cd ECOD/server
pnpm install
pnpm dev
```

### Test Worker Functionality
```bash
cd ECOD/server
pnpm test:session:isolation
```

## Benefits

1. **Separation of Concerns**: Queue logic is in the package, not in the application
2. **Reusability**: Any project can use `@ecodrix/erix-worker` with `@ecodrix/erix-client`
3. **Maintainability**: Updates to worker logic happen in one place
4. **Familiar API**: BullMQ-style API makes it easy for developers to adopt
5. **Type Safety**: Full TypeScript support with type definitions

## Next Steps

1. ✅ Create `@ecodrix/erix-worker` package
2. ✅ Update ECOD/server to use the new package
3. ✅ Build and test the worker
4. 🔄 Remove old `erixWorker.ts` file (optional cleanup)
5. 🔄 Publish packages to npm (when ready)
6. 🔄 Update documentation in other projects

## Environment Variables

```bash
# Required for ECOD/server
ERIX_STORE_URL=https://erix-store.onrender.com
ERIX_API_KEY=your-api-key
ERIX_TENANT_ID=ecodrix
```

## Summary

We've successfully transformed the ERIX worker from a local implementation into a reusable package that follows the BullMQ pattern. Users can now:

1. Import `ErixClient` (like Redis) for queue operations
2. Import `ErixWorker` (like BullMQ) for job processing
3. Use a familiar, industry-standard API
4. Deploy workers that auto-start with their applications

This makes ERIX-Store a complete, production-ready alternative to Redis + BullMQ!
