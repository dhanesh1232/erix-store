/**
 * @module Core/Persistence
 * @responsibility Snapshot persistence for non-queue erix-store state.
 *
 * Architecture:
 *   The job queue is now durable via the WAL (JobWAL.ts). This module handles
 *   snapshot persistence for everything else: StringStore, HashStore, ListStore,
 *   SetStore, SortedSetStore, CacheService, RateLimiter, and DistributedLock.
 *
 * Schema (auto-created on first connect):
 *   store_snapshots (id SERIAL PK, data JSONB NOT NULL, saved_at TIMESTAMPTZ)
 *
 * Only the last 5 snapshots are kept. On restart, the latest snapshot is restored
 * before the HTTP server accepts connections. The queue is rebuilt separately via
 * JobWAL.replay() → JobQueueV2.rebuildFromWAL().
 */

import { Pool } from "pg";
import type { BatchedJobWAL } from "../services/BatchedJobWAL.js";
import type { CacheService } from "../services/CacheService.js";
import type { DistributedLockService } from "../services/DistributedLock.js";
import type { RateLimiterService } from "../services/RateLimiter.js";
import type { ErixStore } from "./Store.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS store_snapshots (
    id       SERIAL PRIMARY KEY,
    data     JSONB        NOT NULL,
    saved_at TIMESTAMPTZ  DEFAULT NOW()
  );
`;

export async function createPgPool(databaseUrl: string): Promise<Pool> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: databaseUrl.includes("supabase.com")
      ? { rejectUnauthorized: false }
      : undefined,
  });

  // Retry the initial connectivity probe with backoff. On a fresh VM boot the
  // cloud-sql-proxy sidecar (compose `depends_on: condition: service_started`)
  // may not be accepting connections yet — failing fast here would bubble up to
  // the bootstrap `catch` and `process.exit(1)`, crash-looping the container so
  // it never becomes healthy and every dependent (ecodrix-jobs) aborts. Waiting
  // for the DB internally is exactly what the compose comment promises.
  const maxAttempts = Number(process.env.PG_CONNECT_RETRIES ?? 30);
  const delayMs = Number(process.env.PG_CONNECT_RETRY_DELAY_MS ?? 2_000);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query(CREATE_TABLE_SQL);
      console.log(
        `[Persistence] Snapshots table ready ✓ (attempt ${attempt}/${maxAttempts})`,
      );
      return pool;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Persistence] Postgres not ready (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in ${delayMs}ms`,
      );
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  await pool.end().catch(() => {});
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `[Persistence] Could not connect to Postgres after ${maxAttempts} attempts: ${reason}`,
  );
}

// ─── PersistenceManager ───────────────────────────────────────────────────────

export class PersistenceManager {
  private store: ErixStore;
  private rateLimiter: RateLimiterService;
  private lock?: DistributedLockService;
  private cache?: CacheService;
  private wal?: BatchedJobWAL;
  private pool: Pool;
  private saveInterval: NodeJS.Timeout | null = null;

  constructor(
    pool: Pool,
    store: ErixStore,
    rateLimiter: RateLimiterService,
    enhanced?: {
      lock?: DistributedLockService;
      cache?: CacheService;
      /** WAL reference — used for periodic pruning of old finalized rows. */
      wal?: BatchedJobWAL;
    },
  ) {
    this.pool = pool;
    this.store = store;
    this.rateLimiter = rateLimiter;
    this.lock = enhanced?.lock;
    this.cache = enhanced?.cache;
    this.wal = enhanced?.wal;
  }

  startAutoSave(intervalMs: number = 5 * 60 * 1000): void {
    console.log(`[Persistence] Auto-save every ${intervalMs / 1000}s`);
    this.saveInterval = setInterval(() => {
      void this.save();
      // Prune WAL rows older than 24h during every auto-save cycle
      void this.wal?.prune();
    }, intervalMs);
  }

  stopAutoSave(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
  }

  /** Serialize all non-queue in-memory state and write a snapshot row to Postgres. */
  async save(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const snapshot: Record<string, unknown> = {
        store: this.store.exportAll(),
        rateLimits: this.rateLimiter.export(),
      };

      if (this.lock) snapshot.lock = this.lock.export();
      if (this.cache) snapshot.cache = this.cache.export();
      // NOTE: queue is intentionally excluded — the WAL owns job durability.

      await client.query("BEGIN");
      await client.query("INSERT INTO store_snapshots (data) VALUES ($1)", [
        JSON.stringify(snapshot),
      ]);
      await client.query(`
        DELETE FROM store_snapshots
        WHERE id NOT IN (
          SELECT id FROM store_snapshots
          ORDER BY saved_at DESC
          LIMIT 5
        )
      `);
      await client.query("COMMIT");
      console.log("[Persistence] Snapshot saved ✓");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[Persistence] Snapshot save failed:", err);
    } finally {
      client.release();
    }
  }

  /** Load the latest snapshot from Postgres and hydrate all in-memory structures. */
  async restore(): Promise<void> {
    try {
      const { rows } = await this.pool.query(
        "SELECT data FROM store_snapshots ORDER BY saved_at DESC LIMIT 1",
      );

      if (!rows.length) {
        console.log(
          "[Persistence] No snapshot found — starting with empty state",
        );
        return;
      }

      // biome-ignore lint/suspicious/noExplicitAny: JSONB persistence boundary
      const data = rows[0].data as Record<string, any>;

      if (data.store) {
        this.store.importAll(data.store);
        console.log("[Persistence] Store restored ✓");
      }
      if (data.rateLimits) {
        this.rateLimiter.import(data.rateLimits);
        console.log("[Persistence] Rate limiter restored ✓");
      }
      if (data.lock && this.lock) {
        this.lock.import(data.lock);
        console.log("[Persistence] Locks restored ✓");
      }
      if (data.cache && this.cache) {
        this.cache.import(data.cache);
        console.log("[Persistence] Cache restored ✓");
      }

      console.log("[Persistence] Restore complete ✓");
    } catch (err) {
      console.error("[Persistence] Restore failed — starting fresh:", err);
    }
  }
}
