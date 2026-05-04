# Erix Store

**Self-hosted, Redis-like in-memory data store with advanced features**

Erix Store is a powerful, zero-dependency infrastructure suite built for ECODrIx platform. It provides enterprise-grade features without vendor lock-in.

---

## 🚀 Features

### Core Data Structures
- ✅ **Strings** - Simple key-value storage
- ✅ **Hashes** - Field-value maps
- ✅ **Lists** - Ordered collections
- ✅ **Sets** - Unique value collections
- ✅ **Sorted Sets** - Scored, ordered sets
- ✅ **TTL Manager** - Automatic expiration

### Advanced Services

#### 1. **Job Queue V2** (Production-Ready)
- ✅ Priority queues (1-10 scale)
- ✅ Delayed execution (runAt, delayMs)
- ✅ Retry with exponential backoff
- ✅ Dead Letter Queue (DLQ)
- ✅ Job progress tracking
- ✅ Concurrency control
- ✅ Event emission (completed, failed, retry)
- ✅ Metrics (throughput, avg processing time)

#### 2. **Distributed Locks**
- ✅ Mutex locks (exclusive)
- ✅ Read/Write locks (multiple readers, single writer)
- ✅ Semaphores (limited concurrency)
- ✅ Lock renewal (heartbeat)
- ✅ Deadlock detection
- ✅ Auto-renewal support

#### 3. **Intelligent Cache**
- ✅ LRU/LFU/FIFO eviction strategies
- ✅ Tag-based invalidation
- ✅ Pattern matching invalidation
- ✅ Cache statistics (hit rate, memory usage)
- ✅ Memory management
- ✅ TTL support
- ✅ Cache warming

#### 4. **Pub/Sub Messaging**
- ✅ Event-driven architecture
- ✅ Channel-based subscriptions
- ✅ Real-time message delivery

#### 5. **Rate Limiting**
- ✅ Token bucket algorithm
- ✅ Per-key rate limits
- ✅ Sliding window
- ✅ Remaining quota tracking

#### 6. **Persistence**
- ✅ MongoDB snapshots
- ✅ Auto-save (configurable interval)
- ✅ Graceful shutdown
- ✅ Data restoration

---

## 📦 Installation

```bash
cd ECOD/erix-store
npm install
```

---

## 🔧 Configuration

Create a `.env` file:

```env
PORT=6399
MONGODB_URI=mongodb://localhost:27017/erix-store
```

---

## 🏃 Running

### Development
```bash
npm run dev
```

### Production
```bash
npm run build
npm start
```

---

## 📖 API Documentation

### Base URL
```
http://localhost:6399
```

---

## 🔄 Job Queue V2 API

### Add a Job
```http
POST /queue/v2/:queueName/jobs
Content-Type: application/json

{
  "data": { "userId": "123", "action": "send_email" },
  "priority": 8,
  "maxAttempts": 3,
  "delayMs": 5000,
  "clientCode": "ACME",
  "metadata": { "source": "api" }
}
```

**Response:**
```json
{
  "success": true,
  "job": {
    "id": "1234567890-abc123",
    "queueName": "emails",
    "status": "delayed",
    "priority": 8,
    "runAt": "2026-05-04T10:30:00.000Z"
  }
}
```

### Get Job Status
```http
GET /queue/v2/jobs/:jobId
```

### Get Queue Metrics
```http
GET /queue/v2/:queueName/metrics
```

**Response:**
```json
{
  "success": true,
  "metrics": {
    "waiting": 45,
    "active": 5,
    "completed": 1250,
    "failed": 12,
    "delayed": 8,
    "dlq": 3,
    "throughput": 2.5,
    "avgProcessingTime": 1234
  }
}
```

### Get Jobs by Status
```http
GET /queue/v2/:queueName/jobs?status=failed
```

### Update Job Progress
```http
PATCH /queue/v2/jobs/:jobId/progress
Content-Type: application/json

{
  "progress": 75
}
```

### Retry Failed Job
```http
POST /queue/v2/jobs/:jobId/retry
```

### Retry All DLQ Jobs
```http
POST /queue/v2/:queueName/dlq/retry
```

### Clear Completed Jobs
```http
DELETE /queue/v2/:queueName/completed
```

---

## 🔒 Distributed Lock API

### Acquire Mutex Lock
```http
POST /lock/acquire
Content-Type: application/json

{
  "key": "process:payment:user123",
  "ttl": 30000,
  "retry": 3,
  "retryDelay": 1000,
  "autoRenew": true
}
```

**Response:**
```json
{
  "success": true,
  "token": "1234567890-xyz789"
}
```

### Release Lock
```http
POST /lock/release
Content-Type: application/json

{
  "key": "process:payment:user123",
  "token": "1234567890-xyz789"
}
```

### Acquire Read Lock
```http
POST /lock/read/acquire
Content-Type: application/json

{
  "key": "document:123",
  "ttl": 60000
}
```

### Acquire Write Lock
```http
POST /lock/write/acquire
Content-Type: application/json

{
  "key": "document:123",
  "ttl": 60000
}
```

### Acquire Semaphore
```http
POST /lock/semaphore/acquire
Content-Type: application/json

{
  "key": "api:rate-limit",
  "limit": 10,
  "retry": 5
}
```

### Check Lock Status
```http
GET /lock/:key/status
```

### Get All Locks
```http
GET /lock/all
```

### Detect Deadlocks
```http
GET /lock/deadlocks
```

### Force Release (Admin)
```http
DELETE /lock/:key/force
```

---

## 💾 Cache API

### Get Value
```http
GET /cache/:key
```

### Set Value
```http
POST /cache/:key
Content-Type: application/json

{
  "value": { "name": "John", "age": 30 },
  "ttl": 3600000,
  "tags": ["users", "active"],
  "metadata": { "source": "api" }
}
```

### Delete Key
```http
DELETE /cache/:key
```

### Check Existence
```http
HEAD /cache/:key
```

### Get Multiple Keys
```http
POST /cache/mget
Content-Type: application/json

{
  "keys": ["user:123", "user:456", "user:789"]
}
```

### Set Multiple Keys
```http
POST /cache/mset
Content-Type: application/json

{
  "entries": [
    {
      "key": "user:123",
      "value": { "name": "John" },
      "options": { "ttl": 3600000, "tags": ["users"] }
    },
    {
      "key": "user:456",
      "value": { "name": "Jane" }
    }
  ]
}
```

### Invalidate by Tag
```http
DELETE /cache/tags/:tag
```

**Example:**
```http
DELETE /cache/tags/users
```

### Invalidate by Multiple Tags
```http
POST /cache/tags/invalidate
Content-Type: application/json

{
  "tags": ["users", "active", "premium"]
}
```

### Invalidate by Pattern
```http
POST /cache/pattern/invalidate
Content-Type: application/json

{
  "pattern": "user:*"
}
```

### Get Statistics
```http
GET /cache/stats
```

**Response:**
```json
{
  "success": true,
  "stats": {
    "hits": 8542,
    "misses": 1234,
    "hitRate": 0.874,
    "size": 52428800,
    "entries": 1250,
    "evictions": 45,
    "expirations": 123
  }
}
```

### Get Memory Usage
```http
GET /cache/memory
```

**Response:**
```json
{
  "success": true,
  "memory": {
    "used": 52428800,
    "max": 524288000,
    "percentage": 10.0
  }
}
```

### Get All Keys
```http
GET /cache/keys
```

### Get Keys by Tag
```http
GET /cache/tags/:tag/keys
```

### Get Entry Metadata
```http
GET /cache/:key/meta
```

### Clear All Cache
```http
DELETE /cache/all
```

---

## 🔌 Client Usage Examples

### Node.js Client

```typescript
import axios from 'axios';

const erixStore = axios.create({
  baseURL: 'http://localhost:6399'
});

// Job Queue
async function enqueueJob() {
  const { data } = await erixStore.post('/queue/v2/emails/jobs', {
    data: { to: 'user@example.com', subject: 'Welcome!' },
    priority: 8,
    delayMs: 5000
  });
  console.log('Job ID:', data.job.id);
}

// Distributed Lock
async function withLock() {
  // Acquire lock
  const { data: { token } } = await erixStore.post('/lock/acquire', {
    key: 'critical-section',
    ttl: 30000,
    retry: 3
  });

  try {
    // Do critical work
    await processCriticalSection();
  } finally {
    // Release lock
    await erixStore.post('/lock/release', {
      key: 'critical-section',
      token
    });
  }
}

// Cache
async function cacheUser(userId: string, userData: any) {
  await erixStore.post(`/cache/user:${userId}`, {
    value: userData,
    ttl: 3600000, // 1 hour
    tags: ['users', 'active']
  });
}

async function getUser(userId: string) {
  try {
    const { data } = await erixStore.get(`/cache/user:${userId}`);
    return data.value;
  } catch (error) {
    // Cache miss - fetch from DB
    const user = await fetchFromDatabase(userId);
    await cacheUser(userId, user);
    return user;
  }
}

// Invalidate all user cache
async function invalidateUsers() {
  await erixStore.delete('/cache/tags/users');
}
```

### Integration with ECODrIx Backend

```typescript
// ECOD/backend/src/lib/erixStore.ts
import axios from 'axios';

export const erixStore = axios.create({
  baseURL: process.env.ERIX_STORE_URL || 'http://localhost:6399'
});

// Use in services
export async function enqueueEmailJob(emailData: any) {
  return erixStore.post('/queue/v2/emails/jobs', {
    data: emailData,
    priority: 7,
    clientCode: 'BACKEND'
  });
}

export async function acquireLock(key: string, ttl: number = 30000) {
  const { data } = await erixStore.post('/lock/acquire', { key, ttl });
  return data.token;
}

export async function releaseLock(key: string, token: string) {
  await erixStore.post('/lock/release', { key, token });
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const { data } = await erixStore.get(`/cache/${key}`);
    return data.value;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: any, options?: any) {
  await erixStore.post(`/cache/${key}`, { value, ...options });
}
```

---

## 🎯 Use Cases

### 1. Prevent Duplicate Job Execution
```typescript
// Acquire lock before processing job
const token = await acquireLock(`job:${jobId}`, 60000);
try {
  await processJob(jobId);
} finally {
  await releaseLock(`job:${jobId}`, token);
}
```

### 2. Cache Lead Data
```typescript
// Cache lead with tags
await cacheSet(`lead:${leadId}`, leadData, {
  ttl: 1800000, // 30 minutes
  tags: ['leads', `pipeline:${pipelineId}`, `tenant:${clientCode}`]
});

// Invalidate all leads in a pipeline
await erixStore.delete(`/cache/tags/pipeline:${pipelineId}`);
```

### 3. Rate Limiting API Calls
```typescript
// Acquire semaphore (max 10 concurrent)
const token = await erixStore.post('/lock/semaphore/acquire', {
  key: 'api:external-service',
  limit: 10
});

try {
  await callExternalAPI();
} finally {
  await erixStore.post('/lock/semaphore/release', {
    key: 'api:external-service',
    token: token.data.token
  });
}
```

### 4. Background Job Processing
```typescript
// Enqueue with priority and delay
await erixStore.post('/queue/v2/notifications/jobs', {
  data: { userId, message },
  priority: 9, // High priority
  delayMs: 300000, // 5 minutes delay
  maxAttempts: 5
});
```

---

## 📊 Monitoring

### Queue Metrics
```bash
curl http://localhost:6399/queue/v2/emails/metrics
```

### Cache Statistics
```bash
curl http://localhost:6399/cache/stats
```

### Lock Status
```bash
curl http://localhost:6399/lock/all
```

### Deadlock Detection
```bash
curl http://localhost:6399/lock/deadlocks
```

---

## 🔐 Security

- **No authentication by default** - Deploy behind a firewall or add auth middleware
- **Internal use only** - Not exposed to public internet
- **Trusted network** - Backend services communicate directly

---

## 🚀 Performance

- **In-memory storage** - Microsecond latency
- **Zero network overhead** - When deployed on same machine
- **Efficient eviction** - LRU/LFU algorithms
- **Concurrent processing** - Configurable worker concurrency

---

## 🛠️ Development

### Run Tests
```bash
npm test
```

### Build
```bash
npm run build
```

### Lint
```bash
npm run lint
```

---

## 📈 Roadmap

### Phase 2 (Next)
- [ ] Time Series Data Store
- [ ] Geospatial Index
- [ ] Full-Text Search
- [ ] Bloom Filters
- [ ] Metrics & Observability
- [ ] Event Sourcing

### Phase 3 (Future)
- [ ] Cluster Mode (Multi-node)
- [ ] Replication
- [ ] Sharding
- [ ] GraphQL API
- [ ] WebSocket Support

---

## 📝 License

Private - ECODrIx Platform

---

## 🤝 Contributing

Internal project - ECODrIx team only

---

## 📧 Support

Contact: ECODrIx Infrastructure Team
