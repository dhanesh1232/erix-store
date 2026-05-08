/**
 * @module Core/Persistence
 * @responsibility Snapshot persistence for erix-store state.
 *
 * Architecture: erix-store is a single-threaded, in-memory data store (like Redis).
 * All runtime operations happen in memory. This module handles durable persistence
 * using PostgreSQL, exactly like Redis's RDB dump — taking a full snapshot of all
 * in-memory state and storing it as JSONB in a single Postgres table.
 *
 * Schema (auto-created on first connect):
 *   erix_snapshots (id SERIAL PK, data JSONB NOT NULL, saved_at TIMESTAMPTZ)
 *
 * Only the last 5 snapshots are kept. On restart, the latest snapshot is restored
 * into memory before the HTTP server starts accepting connections.
 */
import { Pool } from "pg";
// ─── Bootstrap ────────────────────────────────────────────────────────────────
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS erix_snapshots (
    id       SERIAL PRIMARY KEY,
    data     JSONB        NOT NULL,
    saved_at TIMESTAMPTZ  DEFAULT NOW()
  );
`;
/**
 * Create a pg Pool and ensure the snapshots table exists.
 * Called once at startup before constructing PersistenceManager.
 */
export async function createPgPool(databaseUrl) {
    const pool = new Pool({
        connectionString: databaseUrl,
        max: 3, // erix-store is single-threaded — 3 connections is more than enough
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        ssl: databaseUrl.includes("supabase.com")
            ? { rejectUnauthorized: false }
            : undefined,
    });
    await pool.query(CREATE_TABLE_SQL);
    console.log("[Persistence] Snapshots table ready ✓");
    return pool;
}
// ─── PersistenceManager ───────────────────────────────────────────────────────
export class PersistenceManager {
    store;
    rateLimiter;
    queueV2;
    lock;
    cache;
    pool;
    saveInterval = null;
    constructor(pool, store, rateLimiter, enhanced) {
        this.pool = pool;
        this.store = store;
        this.rateLimiter = rateLimiter;
        this.queueV2 = enhanced?.queueV2;
        this.lock = enhanced?.lock;
        this.cache = enhanced?.cache;
    }
    startAutoSave(intervalMs = 5 * 60 * 1000) {
        console.log(`[Persistence] Auto-save every ${intervalMs / 1000}s`);
        this.saveInterval = setInterval(() => void this.save(), intervalMs);
    }
    stopAutoSave() {
        if (this.saveInterval) {
            clearInterval(this.saveInterval);
            this.saveInterval = null;
        }
    }
    /** Serialize all in-memory state and write a snapshot row to Postgres. */
    async save() {
        const client = await this.pool.connect();
        try {
            const snapshot = {
                store: this.store.exportAll(),
                rateLimits: this.rateLimiter.export(),
            };
            if (this.queueV2)
                snapshot.queueV2 = this.queueV2.export();
            if (this.lock)
                snapshot.lock = this.lock.export();
            if (this.cache)
                snapshot.cache = this.cache.export();
            await client.query("BEGIN");
            // Insert new snapshot
            await client.query("INSERT INTO erix_snapshots (data) VALUES ($1)", [
                JSON.stringify(snapshot),
            ]);
            // Prune: keep only the latest 5
            await client.query(`
        DELETE FROM erix_snapshots
        WHERE id NOT IN (
          SELECT id FROM erix_snapshots
          ORDER BY saved_at DESC
          LIMIT 5
        )
      `);
            await client.query("COMMIT");
            console.log("[Persistence] Snapshot saved ✓");
        }
        catch (err) {
            await client.query("ROLLBACK").catch(() => { });
            console.error("[Persistence] Snapshot save failed:", err);
        }
        finally {
            client.release();
        }
    }
    /** Load the latest snapshot from Postgres and hydrate all in-memory structures. */
    async restore() {
        try {
            const { rows } = await this.pool.query("SELECT data FROM erix_snapshots ORDER BY saved_at DESC LIMIT 1");
            if (!rows.length) {
                console.log("[Persistence] No snapshot found — starting with empty state");
                return;
            }
            // biome-ignore lint/suspicious/noExplicitAny: JSONB persistence boundary
            const data = rows[0].data;
            if (data.store) {
                this.store.importAll(data.store);
                console.log("[Persistence] Store restored ✓");
            }
            if (data.rateLimits) {
                this.rateLimiter.import(data.rateLimits);
                console.log("[Persistence] Rate limiter restored ✓");
            }
            if (data.queueV2 && this.queueV2) {
                this.queueV2.import(data.queueV2);
                console.log("[Persistence] QueueV2 restored ✓");
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
        }
        catch (err) {
            console.error("[Persistence] Restore failed — starting fresh:", err);
        }
    }
}
