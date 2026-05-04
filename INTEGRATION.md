# Erix Store Integration Guide

How to integrate Erix Store with ECODrIx Backend

---

## 🔌 Setup

### 1. Install Client in Backend

```bash
cd ECOD/backend
# No additional package needed - use axios (already installed)
```

### 2. Create Erix Store Client

Create `ECOD/backend/src/lib/erixStore.ts`:

```typescript
import axios from 'axios';
import { logger } from './logger';

const ERIX_STORE_URL = process.env.ERIX_STORE_URL || 'http://localhost:6399';

export const erixStore = axios.create({
  baseURL: ERIX_STORE_URL,
  timeout: 10000,
});

// Add request logging
erixStore.interceptors.request.use((config) => {
  logger.debug({ method: config.method, url: config.url }, '[ErixStore] Request');
  return config;
});

// Add response logging
erixStore.interceptors.response.use(
  (response) => {
    logger.debug({ status: response.status }, '[ErixStore] Response');
    return response;
  },
  (error) => {
    logger.error({ error: error.message }, '[ErixStore] Error');
    throw error;
  }
);

// ============================================
// JOB QUEUE HELPERS
// ============================================

export async function enqueueJob(
  queueName: string,
  data: any,
  options: {
    priority?: number;
    delayMs?: number;
    maxAttempts?: number;
    clientCode?: string;
  } = {}
) {
  const { data: response } = await erixStore.post(`/queue/v2/${queueName}/jobs`, {
    data,
    ...options,
  });
  return response.job;
}

export async function getJobStatus(jobId: string) {
  const { data } = await erixStore.get(`/queue/v2/jobs/${jobId}`);
  return data.job;
}

export async function getQueueMetrics(queueName: string) {
  const { data } = await erixStore.get(`/queue/v2/${queueName}/metrics`);
  return data.metrics;
}

export async function retryFailedJob(jobId: string) {
  await erixStore.post(`/queue/v2/jobs/${jobId}/retry`);
}

// ============================================
// DISTRIBUTED LOCK HELPERS
// ============================================

export async function acquireLock(
  key: string,
  options: {
    ttl?: number;
    retry?: number;
    autoRenew?: boolean;
  } = {}
): Promise<string | null> {
  try {
    const { data } = await erixStore.post('/lock/acquire', {
      key,
      ttl: options.ttl ?? 30000,
      retry: options.retry ?? 3,
      retryDelay: 1000,
      autoRenew: options.autoRenew ?? false,
    });
    return data.token;
  } catch (error) {
    logger.warn({ key }, '[Lock] Failed to acquire');
    return null;
  }
}

export async function releaseLock(key: string, token: string): Promise<boolean> {
  try {
    await erixStore.post('/lock/release', { key, token });
    return true;
  } catch (error) {
    logger.error({ key, error }, '[Lock] Failed to release');
    return false;
  }
}

export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  options?: { ttl?: number }
): Promise<T> {
  const token = await acquireLock(key, options);
  if (!token) {
    throw new Error(`Failed to acquire lock: ${key}`);
  }

  try {
    return await fn();
  } finally {
    await releaseLock(key, token);
  }
}

export async function acquireReadLock(key: string, ttl: number = 60000): Promise<string | null> {
  try {
    const { data } = await erixStore.post('/lock/read/acquire', { key, ttl });
    return data.token;
  } catch {
    return null;
  }
}

export async function releaseReadLock(key: string, token: string): Promise<boolean> {
  try {
    await erixStore.post('/lock/read/release', { key, token });
    return true;
  } catch {
    return false;
  }
}

export async function acquireWriteLock(key: string, ttl: number = 60000): Promise<string | null> {
  try {
    const { data } = await erixStore.post('/lock/write/acquire', { key, ttl });
    return data.token;
  } catch {
    return null;
  }
}

export async function releaseWriteLock(key: string, token: string): Promise<boolean> {
  try {
    await erixStore.post('/lock/write/release', { key, token });
    return true;
  } catch {
    return false;
  }
}

// ============================================
// CACHE HELPERS
// ============================================

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const { data } = await erixStore.get(`/cache/${key}`);
    return data.value;
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: any,
  options: {
    ttl?: number;
    tags?: string[];
    metadata?: Record<string, any>;
  } = {}
): Promise<void> {
  await erixStore.post(`/cache/${key}`, {
    value,
    ttl: options.ttl ?? 3600000, // 1 hour default
    tags: options.tags,
    metadata: options.metadata,
  });
}

export async function cacheDelete(key: string): Promise<boolean> {
  try {
    await erixStore.delete(`/cache/${key}`);
    return true;
  } catch {
    return false;
  }
}

export async function cacheHas(key: string): Promise<boolean> {
  try {
    await erixStore.head(`/cache/${key}`);
    return true;
  } catch {
    return false;
  }
}

export async function cacheInvalidateByTag(tag: string): Promise<number> {
  const { data } = await erixStore.delete(`/cache/tags/${tag}`);
  return data.count;
}

export async function cacheInvalidateByPattern(pattern: string): Promise<number> {
  const { data } = await erixStore.post('/cache/pattern/invalidate', { pattern });
  return data.count;
}

export async function cacheGetOrSet<T>(
  key: string,
  factory: () => Promise<T>,
  options?: { ttl?: number; tags?: string[] }
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) {
    return cached;
  }

  const value = await factory();
  await cacheSet(key, value, options);
  return value;
}

export async function getCacheStats() {
  const { data } = await erixStore.get('/cache/stats');
  return data.stats;
}
```

---

## 🎯 Usage Examples

### 1. Replace ErixJobs with Erix Store Queue

**Before (Current):**
```typescript
// ECOD/backend/src/lib/erixJobs/index.ts
const queue = ErixJobs.getQueue('crm.automation');
await queue.add(clientCode, { leadId, ruleId }, { delayMs: 5000 });
```

**After (With Erix Store):**
```typescript
import { enqueueJob } from '@lib/erixStore';

await enqueueJob('crm.automation', 
  { leadId, ruleId },
  { 
    priority: 8,
    delayMs: 5000,
    clientCode,
    maxAttempts: 3
  }
);
```

### 2. Prevent Duplicate Job Execution

**In `crmWorker.ts`:**
```typescript
import { withLock } from '@lib/erixStore';

async function processAutomationJob(job: any) {
  const lockKey = `automation:${job.data.ruleId}:${job.data.leadId}`;
  
  await withLock(lockKey, async () => {
    // This code runs exclusively
    await runAutomations(job.data.leadId, job.data.ruleId);
  }, { ttl: 60000 });
}
```

### 3. Cache Lead Data

**In `lead.service.ts`:**
```typescript
import { cacheGet, cacheSet, cacheInvalidateByTag } from '@lib/erixStore';

export async function getLeadById(clientCode: string, leadId: string) {
  const cacheKey = `lead:${clientCode}:${leadId}`;
  
  // Try cache first
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return cached;
  }

  // Cache miss - fetch from DB
  const { Lead } = await getCrmModels(clientCode);
  const lead = await Lead.findById(leadId).populate('pipeline stage');

  // Cache with tags
  await cacheSet(cacheKey, lead, {
    ttl: 1800000, // 30 minutes
    tags: [
      'leads',
      `tenant:${clientCode}`,
      `pipeline:${lead.pipelineId}`,
      `stage:${lead.stageId}`
    ]
  });

  return lead;
}

export async function updateLead(clientCode: string, leadId: string, updates: any) {
  const { Lead } = await getCrmModels(clientCode);
  const lead = await Lead.findByIdAndUpdate(leadId, updates, { new: true });

  // Invalidate cache
  await cacheDelete(`lead:${clientCode}:${leadId}`);

  return lead;
}

export async function invalidatePipelineCache(clientCode: string, pipelineId: string) {
  // Invalidate all leads in this pipeline
  await cacheInvalidateByTag(`pipeline:${pipelineId}`);
}
```

### 4. Cache Template Resolution

**In `template.service.ts`:**
```typescript
import { cacheGetOrSet } from '@lib/erixStore';

export async function getResolvedTemplate(
  clientCode: string,
  templateName: string,
  context: any
) {
  const cacheKey = `template:${clientCode}:${templateName}:${hashContext(context)}`;

  return cacheGetOrSet(
    cacheKey,
    async () => {
      // Expensive template resolution
      const template = await fetchTemplate(clientCode, templateName);
      return resolveVariables(template, context);
    },
    {
      ttl: 600000, // 10 minutes
      tags: ['templates', `tenant:${clientCode}`]
    }
  );
}
```

### 5. Rate Limit External API Calls

**In `whatsapp.service.ts`:**
```typescript
import { erixStore } from '@lib/erixStore';

export async function sendWhatsAppMessage(clientCode: string, data: any) {
  // Acquire semaphore (max 10 concurrent WhatsApp API calls)
  const { data: { token } } = await erixStore.post('/lock/semaphore/acquire', {
    key: `whatsapp:api:${clientCode}`,
    limit: 10,
    retry: 5,
    retryDelay: 2000
  });

  try {
    // Call WhatsApp API
    const result = await axios.post(WHATSAPP_API_URL, data);
    return result.data;
  } finally {
    // Release semaphore
    await erixStore.post('/lock/semaphore/release', {
      key: `whatsapp:api:${clientCode}`,
      token
    });
  }
}
```

### 6. Read/Write Locks for Document Editing

**In `document.service.ts`:**
```typescript
import { acquireReadLock, releaseReadLock, acquireWriteLock, releaseWriteLock } from '@lib/erixStore';

export async function readDocument(docId: string) {
  const token = await acquireReadLock(`doc:${docId}`, 60000);
  if (!token) {
    throw new Error('Failed to acquire read lock');
  }

  try {
    // Multiple readers can read simultaneously
    return await fetchDocument(docId);
  } finally {
    await releaseReadLock(`doc:${docId}`, token);
  }
}

export async function updateDocument(docId: string, updates: any) {
  const token = await acquireWriteLock(`doc:${docId}`, 60000);
  if (!token) {
    throw new Error('Failed to acquire write lock');
  }

  try {
    // Exclusive write access
    return await saveDocument(docId, updates);
  } finally {
    await releaseWriteLock(`doc:${docId}`, token);
  }
}
```

### 7. Background Job with Progress Tracking

**In `export.service.ts`:**
```typescript
import { enqueueJob, erixStore } from '@lib/erixStore';

export async function exportLeads(clientCode: string, filters: any) {
  // Enqueue export job
  const job = await enqueueJob('exports', 
    { clientCode, filters },
    { 
      priority: 5,
      maxAttempts: 1 // Don't retry exports
    }
  );

  return job.id;
}

// In worker
async function processExport(job: any) {
  const { clientCode, filters } = job.data;
  const { Lead } = await getCrmModels(clientCode);

  const total = await Lead.countDocuments(filters);
  let processed = 0;

  const leads = await Lead.find(filters).cursor();

  for await (const lead of leads) {
    // Process lead
    await exportLead(lead);
    
    processed++;
    const progress = Math.floor((processed / total) * 100);
    
    // Update progress
    await erixStore.patch(`/queue/v2/jobs/${job.id}/progress`, { progress });
  }
}
```

---

## 🔄 Migration Strategy

### Phase 1: Parallel Running
1. Keep existing ErixJobs
2. Add Erix Store alongside
3. Test with non-critical jobs

### Phase 2: Gradual Migration
1. Migrate email jobs to Erix Store
2. Migrate WhatsApp jobs
3. Migrate automation jobs

### Phase 3: Full Cutover
1. Remove old ErixJobs
2. Update all references
3. Monitor performance

---

## 📊 Monitoring Integration

Add to your monitoring dashboard:

```typescript
// ECOD/backend/src/routes/saas/health.routes.ts
import { getQueueMetrics, getCacheStats, erixStore } from '@lib/erixStore';

router.get('/health/erix-store', async (req, res) => {
  try {
    const queueMetrics = await getQueueMetrics('crm.automation');
    const cacheStats = await getCacheStats();
    const { data: locks } = await erixStore.get('/lock/all');

    res.json({
      success: true,
      erixStore: {
        queue: queueMetrics,
        cache: cacheStats,
        locks: locks.count
      }
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Erix Store unavailable'
    });
  }
});
```

---

## 🚀 Performance Tips

1. **Cache Frequently Accessed Data**
   - Lead profiles
   - Template definitions
   - Pipeline configurations

2. **Use Tags for Bulk Invalidation**
   - Invalidate all leads in a pipeline
   - Clear tenant-specific cache

3. **Set Appropriate TTLs**
   - Short TTL (5-10 min): Dynamic data
   - Medium TTL (30-60 min): Semi-static data
   - Long TTL (2-4 hours): Static data

4. **Use Locks Sparingly**
   - Only for critical sections
   - Keep lock duration short
   - Use read locks when possible

5. **Monitor Queue Depth**
   - Alert if queue > 1000 jobs
   - Scale workers if needed

---

## 🔐 Security Considerations

1. **Network Isolation**
   - Deploy Erix Store on private network
   - Only backend can access

2. **No Public Exposure**
   - Never expose Erix Store to internet
   - Use firewall rules

3. **Audit Logging**
   - Log all lock acquisitions
   - Track cache invalidations
   - Monitor job failures

---

## 📈 Scaling

### Vertical Scaling
- Increase memory for cache
- More CPU for job processing

### Horizontal Scaling (Future)
- Multiple Erix Store instances
- Load balancer
- Shared MongoDB for persistence

---

## 🐛 Troubleshooting

### Queue Jobs Not Processing
```bash
# Check queue metrics
curl http://localhost:6399/queue/v2/crm.automation/metrics

# Check DLQ
curl http://localhost:6399/queue/v2/crm.automation/jobs?status=failed
```

### Lock Deadlocks
```bash
# Detect deadlocks
curl http://localhost:6399/lock/deadlocks

# Force release if needed
curl -X DELETE http://localhost:6399/lock/critical-section/force
```

### Cache Memory Issues
```bash
# Check memory usage
curl http://localhost:6399/cache/memory

# Clear if needed
curl -X DELETE http://localhost:6399/cache/all
```

---

## ✅ Checklist

- [ ] Add Erix Store client to backend
- [ ] Update environment variables
- [ ] Test job queue integration
- [ ] Test distributed locks
- [ ] Test cache layer
- [ ] Add monitoring endpoints
- [ ] Update deployment scripts
- [ ] Document for team

---

## 📞 Support

Internal tool - contact Infrastructure Team for issues.
