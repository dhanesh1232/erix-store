/**
 * @file index.ts
 * @module ErixStore/Bootstrap
 *
 * erix-store — a single-threaded, in-memory data structure server.
 *
 * Architecture (same as Redis):
 *   - All data lives in process memory (StringStore, HashStore, ListStore, etc.)
 *   - Requests are served synchronously by the Node.js event loop
 *   - PostgreSQL is used ONLY for periodic state snapshots (like Redis RDB)
 *   - On restart, the latest snapshot is loaded back into memory before serving
 *
 * Bootstrap sequence:
 *   1. Connect to PostgreSQL (Supabase) and ensure snapshot table exists
 *   2. Initialise all in-memory services
 *   3. Restore latest snapshot into memory
 *   4. Start auto-save timer (every 5 minutes)
 *   5. Start HTTP server
 */
import dotenv from "dotenv";
import { createPgPool, PersistenceManager } from "./core/Persistence.js";
import { ErixStore } from "./core/Store.js";
import { createApp } from "./server/app.js";
import { AnomalyDetector } from "./services/AnomalyDetector.js";
import { CacheService } from "./services/CacheService.js";
import { DistributedLockService } from "./services/DistributedLock.js";
import { JobQueueV2 } from "./services/JobQueueV2.js";
import { PubSubService } from "./services/PubSub.js";
import { RateLimiterService } from "./services/RateLimiter.js";
import { SemanticCacheService } from "./services/SemanticCacheService.js";
import { UsageMeter } from "./services/UsageMeter.js";
dotenv.config();
const PORT = parseInt(process.env.PORT ?? "6399", 10);
const DATABASE_URL = process.env.DATABASE_URL;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? "";
if (!DATABASE_URL) {
    console.error("[ErixStore] ERROR: DATABASE_URL is not set");
    process.exit(1);
}
// ─── In-memory services (the Redis-equivalent layer) ──────────────────────────
const store = new ErixStore();
const queueV2 = new JobQueueV2({
    maxConcurrency: 10,
    defaultMaxAttempts: 3,
    retryBackoff: "exponential",
    dlqEnabled: true,
});
const pubsub = new PubSubService();
const rateLimiter = new RateLimiterService();
const lock = new DistributedLockService();
const cache = new CacheService({
    strategy: "LRU",
    maxSize: 512 * 1024 * 1024, // 512 MB
    maxEntries: 50_000,
    defaultTTL: 3_600_000, // 1 hour
    enableStats: true,
});
// ─── AI & Analytics layer ────────────────────────────────────────────────────
const anomaly = new AnomalyDetector(pubsub, {
    windowSize: 288, // 24h at 5-min intervals
    thresholdZ: 3.0,
    checkIntervalMs: 5 * 60 * 1000,
});
// SemanticCache is optional — degrades gracefully if GOOGLE_API_KEY is missing
const semantic = GOOGLE_API_KEY
    ? new SemanticCacheService({
        googleApiKey: GOOGLE_API_KEY,
        similarityThreshold: 0.92,
    })
    : null;
if (!GOOGLE_API_KEY) {
    console.warn("[ErixStore] GOOGLE_API_KEY not set — semantic cache disabled");
}
// ─── Event wiring (monitoring + anomaly feed) ────────────────────────────────
queueV2.on("job:completed", (job) => {
    console.log(`[Queue] ✓ ${job.id}`);
});
queueV2.on("job:failed", (job) => {
    console.error(`[Queue] ✗ ${job.id} — ${job.error}`);
});
queueV2.on("job:dlq", (job) => {
    console.error(`[Queue] DLQ ${job.id}`);
});
queueV2.on("job:zombie", (job) => {
    console.warn(`[Queue] Zombie reaped: ${job.id}`);
});
lock.on("lock:acquired", ({ key }) => {
    console.log(`[Lock] acquired: ${key}`);
});
cache.on("cache:evicted", ({ strategy, count }) => {
    console.log(`[Cache] evicted ${count} entries (${strategy})`);
});
// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function bootstrap() {
    try {
        // Step 1: Connect to Postgres and ensure snapshot table exists
        console.log("[ErixStore] Connecting to PostgreSQL…");
        const pool = await createPgPool(DATABASE_URL);
        console.log("[ErixStore] PostgreSQL ready ✓");
        // Ensure metering table exists (idempotent)
        await pool.query(`
			CREATE TABLE IF NOT EXISTS erix_usage_events (
				id          BIGSERIAL PRIMARY KEY,
				tenant_id   TEXT NOT NULL,
				event_type  TEXT NOT NULL,
				count       INTEGER NOT NULL DEFAULT 1,
				recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`);
        // Step 2: Build persistence manager
        const persistence = new PersistenceManager(pool, store, rateLimiter, {
            queueV2,
            lock,
            cache,
        });
        // Step 3: Restore latest snapshot into memory
        await persistence.restore();
        // Step 4: Start periodic auto-save (every 5 minutes)
        persistence.startAutoSave();
        // Step 5: Start usage meter (flushes to Postgres every 10s)
        const meter = new UsageMeter(pool, anomaly);
        // Step 6: Create and start HTTP server
        const app = createApp(store, pubsub, rateLimiter, {
            queueV2,
            lock,
            cache,
            semantic: semantic ?? undefined,
            meter,
            anomaly,
        });
        const server = app.listen(PORT, () => {
            console.log(`\n🚀 ErixStore running on port ${PORT}`);
            console.log(`   ├─ Job Queue       (priority + DLQ + retry + heartbeat)`);
            console.log(`   ├─ Distributed Locks  (mutex, R/W, semaphore)`);
            console.log(`   ├─ LRU Cache       (512 MB, tag-based + SWR)`);
            console.log(`   ├─ Pub/Sub         (event bus + SSE delivery)`);
            console.log(`   ├─ Rate Limiter    (sliding window)`);
            console.log(`   ├─ Anomaly Detector (Z-score, pub/sub alerts)`);
            console.log(`   ├─ Usage Meter     (per-tenant, Postgres flush)`);
            console.log(`   ├─ Semantic Cache  (${semantic ? "✓ Google embeddings" : "✗ disabled — set GOOGLE_API_KEY"})`);
            console.log(`   └─ Snapshots       → PostgreSQL (every 5 min)\n`);
        });
        // ─── Graceful shutdown ───────────────────────────────────────────────
        const shutdown = async (signal) => {
            console.log(`\n[ErixStore] ${signal} received — shutting down…`);
            server.close(async () => {
                console.log("[ErixStore] HTTP server closed");
                persistence.stopAutoSave();
                await persistence.save();
                // Destroy all timed services
                queueV2.destroy();
                lock.destroy();
                cache.destroy();
                rateLimiter.destroy();
                anomaly.destroy();
                meter.destroy();
                await pool.end();
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
    }
    catch (err) {
        console.error("[ErixStore] Bootstrap failed:", err);
        process.exit(1);
    }
}
bootstrap();
