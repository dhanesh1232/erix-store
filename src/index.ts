/**
 * @file index.ts
 * @module ErixStore/Bootstrap
 *
 * erix-store — a single-threaded, in-memory data structure server.
 *
 * Architecture (inspired by Redis's single-threaded model):
 *   - All data lives in process memory
 *   - Requests are served by the Node.js event loop
 *   - PostgreSQL is used for two persistence layers:
 *       1. Job WAL   — per-mutation log → zero job loss on crash
 *       2. Snapshots — 5-min full dump for all non-queue state
 *
 * Bootstrap sequence:
 *   1. Connect to PostgreSQL; ensure all tables exist
 *   2. Create JobWAL; replay surviving jobs into JobQueueV2
 *   3. Restore latest snapshot for all other state
 *   4. Start auto-save timer (every 5 minutes)
 *   5. Start HTTP server
 */

import dotenv from "dotenv";
import { createPgPool, PersistenceManager } from "./core/Persistence.js";
import { ErixStore } from "./core/Store.js";
import { createApp } from "./server/app.js";
import { dispatchCommand } from "./server/commands.js";
import { attachWebSocket } from "./server/ws.js";
import { createRouteHandler } from "./server/wsRouteHandler.js";
import { AnomalyDetector } from "./services/AnomalyDetector.js";
import { BatchedJobWAL } from "./services/BatchedJobWAL.js";
import { CacheService } from "./services/CacheService.js";
import {
  ConfigRegistry,
  parseEnum,
  parseNonNegInt,
  parsePosInt,
} from "./services/ConfigRegistry.js";
import { AofLog, type FsyncPolicy } from "./services/AofLog.js";
import { DataRetentionService } from "./services/DataRetention.js";
import { DistributedLockService } from "./services/DistributedLock.js";
import { JobQueueV2 } from "./services/JobQueueV2.js";
import { PriorityQueue } from "./services/PriorityQueue.js";
import { PubSubService } from "./services/PubSub.js";
import { RateLimiterService } from "./services/RateLimiter.js";
import { SemanticCacheService } from "./services/SemanticCacheService.js";
import { SlowLog } from "./services/SlowLog.js";
import { UsageMeter } from "./services/UsageMeter.js";

dotenv.config();

const PORT = parseInt(process.env.PORT ?? "6399", 10);
const DATABASE_URL = process.env.DATABASE_URL;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? "";

if (!DATABASE_URL) {
  console.error("[ErixStore] ERROR: DATABASE_URL is not set");
  process.exit(1);
}

// ─── In-memory services ────────────────────────────────────────────────────────

// Memory cap (bytes) and policy come from env. Defaults: cap disabled,
// noeviction. Both are runtime-tunable via CONFIG SET in a later batch.
const MAX_MEMORY = parseInt(process.env.ERIX_MAX_MEMORY ?? "0", 10);
const RAW_POLICY = (
  process.env.ERIX_MAX_MEMORY_POLICY ?? "noeviction"
).toLowerCase();
const MAX_MEMORY_POLICY: "noeviction" | "allkeys-lru" | "volatile-lru" =
  RAW_POLICY === "allkeys-lru" || RAW_POLICY === "volatile-lru"
    ? RAW_POLICY
    : "noeviction";

const store = new ErixStore({
  memory: { maxBytes: MAX_MEMORY, policy: MAX_MEMORY_POLICY },
});
const pubsub = new PubSubService();
const rateLimiter = new RateLimiterService();
const lock = new DistributedLockService();
const queue = new PriorityQueue();

// Slowlog: capture every command exceeding `ERIX_SLOWLOG_THRESHOLD_US`
// (default 1 ms). Set to 0 to disable. `ERIX_SLOWLOG_MAX_LEN` caps the
// ring buffer (default 128).
const SLOWLOG_THRESHOLD_US = parseInt(
  process.env.ERIX_SLOWLOG_THRESHOLD_US ?? "1000",
  10,
);
const SLOWLOG_MAX_LEN = parseInt(process.env.ERIX_SLOWLOG_MAX_LEN ?? "128", 10);
const slowlog = new SlowLog({
  thresholdUs: SLOWLOG_THRESHOLD_US,
  maxLen: SLOWLOG_MAX_LEN,
});

// Runtime-tunable parameters. CONFIG GET is open to any tenant; CONFIG
// SET is gated on `ERIX_ADMIN_TENANT_ID` matching the calling tenant.
const ADMIN_TENANT_ID = process.env.ERIX_ADMIN_TENANT_ID;
const config = new ConfigRegistry();
config.register({
  name: "maxmemory",
  get: () => String(store.accountant.maxBytes),
  set: (raw) => store.accountant.setMaxBytes(parseNonNegInt(raw, "maxmemory")),
});
config.register({
  name: "maxmemory-policy",
  get: () => store.accountant.policy,
  set: (raw) => {
    const policy = parseEnum(raw, "maxmemory-policy", [
      "noeviction",
      "allkeys-lru",
      "volatile-lru",
    ] as const);
    store.accountant.setPolicy(policy);
  },
});
config.register({
  name: "slowlog-log-slower-than",
  get: () => String(slowlog.thresholdUs),
  set: (raw) =>
    slowlog.setThresholdUs(parseNonNegInt(raw, "slowlog-log-slower-than")),
});
config.register({
  name: "slowlog-max-len",
  get: () => String(slowlog.maxLen),
  set: (raw) => slowlog.setMaxLen(parsePosInt(raw, "slowlog-max-len")),
});

// AOF: optional local append-only log for command-level durability.
// Set ERIX_AOF_PATH to an absolute path to enable. fsync policy comes
// from ERIX_AOF_FSYNC (default `everysec`). When unset, the AOF
// machinery is skipped entirely — Postgres snapshots remain the sole
// persistence layer (the existing 1.x behaviour).
const AOF_PATH = process.env.ERIX_AOF_PATH;
const RAW_FSYNC = (process.env.ERIX_AOF_FSYNC ?? "everysec").toLowerCase();
const AOF_FSYNC: FsyncPolicy =
  RAW_FSYNC === "always" || RAW_FSYNC === "no" ? RAW_FSYNC : "everysec";
const aof = AOF_PATH
  ? new AofLog({ path: AOF_PATH, fsyncPolicy: AOF_FSYNC })
  : undefined;

const cache = new CacheService({
  strategy: "LRU",
  maxSize: 512 * 1024 * 1024, // 512 MB
  maxEntries: 50_000,
  defaultTTL: 3_600_000, // 1 hour
  enableStats: true,
});

// ─── AI & Analytics layer ──────────────────────────────────────────────────────

const anomaly = new AnomalyDetector(pubsub, {
  windowSize: 288, // 24h at 5-min intervals
  thresholdZ: 3.0,
  checkIntervalMs: 5 * 60 * 1000,
});

const semantic = GOOGLE_API_KEY
  ? new SemanticCacheService({
      googleApiKey: GOOGLE_API_KEY,
      similarityThreshold: 0.92,
    })
  : null;

if (!GOOGLE_API_KEY) {
  console.warn("[ErixStore] GOOGLE_API_KEY not set — semantic cache disabled");
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  try {
    // ── Step 1: Connect to Postgres ──────────────────────────────────────────
    console.log("[ErixStore] Connecting to PostgreSQL…");
    const pool = await createPgPool(DATABASE_URL as string);
    console.log("[ErixStore] PostgreSQL ready ✓");

    // Ensure metering table exists (idempotent)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_usage_events (
        id          BIGSERIAL PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        count       INTEGER NOT NULL DEFAULT 1,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── Step 2: Initialise WAL ────────────────────────────────────────────────
    const wal = new BatchedJobWAL(pool);
    await wal.initialize();

    // ── Step 3: Initialise JobQueueV2 with WAL injection ─────────────────────
    const queueV2 = new JobQueueV2(
      {
        maxConcurrency: 10,
        defaultMaxAttempts: 3,
        retryBackoff: "exponential",
        dlqEnabled: true,
      },
      wal, // WAL is injected here — every mutation is now logged to Postgres
    );

    // ── Step 4: Rebuild queue from WAL before serving any requests ────────────
    const survivingJobs = await wal.replay();
    queueV2.rebuildFromWAL(survivingJobs);

    // ── Step 5: Restore non-queue snapshot ───────────────────────────────────
    const persistence = new PersistenceManager(pool, store, rateLimiter, {
      lock,
      cache,
      wal, // Used for periodic WAL pruning during auto-save
    });
    await persistence.restore();

    // ── Step 5b: Replay AOF on top of the snapshot ────────────────────────────
    // The AOF carries every mutation from the moment of the last
    // snapshot forward, so applying it after restore gives us a
    // consistent view that includes anything written between the
    // snapshot and the crash. Replay is dispatcher-driven so any
    // mutating verb known to the dispatcher is automatically replayable.
    if (aof) {
      const applied = aof.replay((entry) => {
        const result = dispatchCommand(
          { store, queue, pubsub, slowlog, config, aof },
          entry.tenantId,
          { name: entry.name, args: entry.args },
        );
        if (!result.ok) {
          console.warn(
            `[AofLog] replay command ${entry.name} failed: ${result.error}`,
          );
        }
      });
      console.log(`[AofLog] replayed ${applied} entries from ${aof.filePath}`);
    }

    // ── Step 6: Start auto-save (every 5 minutes) ────────────────────────────
    persistence.startAutoSave();

    // ── Step 7: Start usage meter ─────────────────────────────────────────────
    const meter = new UsageMeter(pool, anomaly);

    // ── Step 7b: Start data retention (auto-cleanup every 6h) ─────────────────
    const retention = new DataRetentionService(pool, {
      walTerminalRetentionHours: 24, // Delete completed/failed WAL rows after 24h
      walHardLimitDays: 7, // Hard delete ALL WAL rows after 7 days
      orphanTimeoutHours: 48, // Clean stuck jobs after 48h
      maxSnapshots: 5, // Keep only 5 snapshots
      intervalHours: 6, // Run cleanup every 6 hours
    });
    retention.start();

    // ── Step 8: Event wiring (observability) ─────────────────────────────────
    queueV2.on("job:completed", (job) =>
      console.log(`[Queue] ✓ ${job.id} (${job.queueName})`),
    );
    queueV2.on("job:failed", (job) =>
      console.error(`[Queue] ✗ ${job.id} — ${job.error}`),
    );
    queueV2.on("job:dlq", (job) => console.error(`[Queue] DLQ ${job.id}`));
    queueV2.on("job:zombie", (job) =>
      console.warn(`[Queue] Zombie reaped: ${job.id}`),
    );

    lock.on("lock:acquired", ({ key }: { key: string }) => {
      console.log(`[Lock] acquired: ${key}`);
    });
    cache.on(
      "cache:evicted",
      ({ strategy, count }: { strategy: string; count: number }) => {
        console.log(`[Cache] evicted ${count} entries (${strategy})`);
      },
    );

    // ── Step 9: Start HTTP server ─────────────────────────────────────────────
    const app = createApp(store, pubsub, rateLimiter, {
      queueV2,
      queue,
      lock,
      cache,
      semantic: semantic ?? undefined,
      meter,
      anomaly,
      slowlog,
      config,
      adminTenantId: ADMIN_TENANT_ID,
      bgsave: () => persistence.save(),
      aof,
    });

    const server = app.listen(PORT, () => {
      console.log(`\n🚀 ErixStore running on port http://localhost:${PORT}`);
      console.log(
        `   ├─ Job Queue       (WAL-backed, priority + DLQ + retry + heartbeat)`,
      );
      console.log(`   ├─ Priority Queue  (ENQUEUE/DEQUEUE/QLEN/QPEEK/QCLEAR)`);
      console.log(`   ├─ Transactions     (MULTI/EXEC, atomic single-tick)`);
      console.log(
        `   ├─ Slowlog         (threshold ${SLOWLOG_THRESHOLD_US}µs, capacity ${SLOWLOG_MAX_LEN})`,
      );
      console.log(
        `   ├─ Config / BGSAVE  (admin tenant: ${ADMIN_TENANT_ID ? `'${ADMIN_TENANT_ID}'` : "disabled — set ERIX_ADMIN_TENANT_ID"})`,
      );
      console.log(
        `   ├─ AOF             (${aof ? `enabled at ${aof.filePath}, fsync=${AOF_FSYNC}` : "disabled — set ERIX_AOF_PATH"})`,
      );
      console.log(`   ├─ Distributed Locks  (mutex, R/W, semaphore)`);
      console.log(`   ├─ LRU Cache       (512 MB, tag-based + SWR)`);
      console.log(`   ├─ Pub/Sub         (event bus + SSE delivery)`);
      console.log(`   ├─ Rate Limiter    (sliding window)`);
      console.log(`   ├─ Anomaly Detector (Z-score, pub/sub alerts)`);
      console.log(`   ├─ Usage Meter     (per-tenant, Postgres flush)`);
      console.log(
        `   ├─ Data Retention  (auto-cleanup every 6h, 7-day WAL limit)`,
      );
      console.log(
        `   ├─ Semantic Cache  (${semantic ? "✓ Google embeddings" : "✗ disabled — set GOOGLE_API_KEY"})`,
      );
      console.log(`   ├─ WebSocket       (binary MessagePack, same port)`);
      console.log(`   └─ Snapshots       → PostgreSQL (every 5 min)\n`);
    });

    // ── Step 10: Attach WebSocket server (same port as HTTP) ──────────────────
    const routeHandler = createRouteHandler(app);
    attachWebSocket(server, routeHandler);

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    let isShuttingDown = false;
    const shutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`\n[ErixStore] ${signal} received — shutting down…`);

      server.close(async () => {
        console.log("[ErixStore] HTTP server closed");

        persistence.stopAutoSave();
        retention.stop();
        // Final snapshot + WAL prune
        await persistence.save();
        await wal.prune();

        // Destroy all timed services
        await queueV2.destroy();
        lock.destroy();
        cache.destroy();
        rateLimiter.destroy();
        anomaly.destroy();
        meter.destroy();
        // Flush + close the AOF after every other source of writes
        // has been quiesced, so nothing appends post-close.
        if (aof) aof.close();

        try {
          await pool.end();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[ErixStore] Error closing database pool:", message);
        }

        console.log("[ErixStore] Shutdown complete ✓");
        process.exit(0);
      });

      setTimeout(() => {
        console.error("[ErixStore] Forced exit after timeout");
        process.exit(1);
      }, 10_000);
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (err) {
    console.error("[ErixStore] Bootstrap failed:", err);
    process.exit(1);
  }
}

bootstrap();
