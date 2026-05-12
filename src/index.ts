/**
 * @file index.ts
 * @module ErixStore/Bootstrap
 *
 * erix-store — a single-threaded, in-memory data structure server.
 *
 * Architecture (same philosophy as Redis):
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
import { attachWebSocket } from "./server/ws.js";
import { createRouteHandler } from "./server/wsRouteHandler.js";
import { AnomalyDetector } from "./services/AnomalyDetector.js";
import { BatchedJobWAL } from "./services/BatchedJobWAL.js";
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

// ─── In-memory services ────────────────────────────────────────────────────────

const store = new ErixStore();
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
      CREATE TABLE IF NOT EXISTS erix_usage_events (
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

		// ── Step 6: Start auto-save (every 5 minutes) ────────────────────────────
		persistence.startAutoSave();

		// ── Step 7: Start usage meter ─────────────────────────────────────────────
		const meter = new UsageMeter(pool, anomaly);

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
			lock,
			cache,
			semantic: semantic ?? undefined,
			meter,
			anomaly,
		});

		const server = app.listen(PORT, () => {
			console.log(`\n🚀 ErixStore running on port ${PORT}`);
			console.log(
				`   ├─ Job Queue       (WAL-backed, priority + DLQ + retry + heartbeat)`,
			);
			console.log(`   ├─ Distributed Locks  (mutex, R/W, semaphore)`);
			console.log(`   ├─ LRU Cache       (512 MB, tag-based + SWR)`);
			console.log(`   ├─ Pub/Sub         (event bus + SSE delivery)`);
			console.log(`   ├─ Rate Limiter    (sliding window)`);
			console.log(`   ├─ Anomaly Detector (Z-score, pub/sub alerts)`);
			console.log(`   ├─ Usage Meter     (per-tenant, Postgres flush)`);
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
