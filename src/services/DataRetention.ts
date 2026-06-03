/**
 * @module Services/DataRetention
 * @responsibility Automatic cleanup of old data to prevent Supabase storage overflow.
 *
 * Runs on a configurable schedule (default: every 6 hours) and cleans:
 *   - WAL rows: completed/failed jobs older than 24h (already done by WAL.prune())
 *   - WAL rows: ALL rows older than 7 days (safety net)
 *   - Snapshots: keeps only last 5 (already done by PersistenceManager)
 *   - Orphaned WAL rows: jobs stuck in non-terminal state for > 48h
 *
 * Storage budget:
 *   Supabase Free: 500MB | Pro: 8GB
 *   WAL at 1000 jobs/day × 5 events/job × 1KB/row = ~5MB/day
 *   Without cleanup: 150MB/month → exceeds free tier in 3 months
 *   With cleanup (7-day retention): ~35MB steady state
 */

import type { Pool } from "pg";

export interface RetentionConfig {
	/** WAL terminal rows retention in hours. Default: 24. */
	walTerminalRetentionHours: number;
	/** WAL ALL rows hard limit in days. Default: 7. */
	walHardLimitDays: number;
	/** Orphaned (stuck) jobs timeout in hours. Default: 48. */
	orphanTimeoutHours: number;
	/** Max snapshots to keep. Default: 5. */
	maxSnapshots: number;
	/** Run cleanup every N hours. Default: 6. */
	intervalHours: number;
}

const DEFAULT_CONFIG: RetentionConfig = {
	walTerminalRetentionHours: 24,
	walHardLimitDays: 7,
	orphanTimeoutHours: 48,
	maxSnapshots: 5,
	intervalHours: 6,
};

export class DataRetentionService {
	private pool: Pool;
	private config: RetentionConfig;
	private interval: NodeJS.Timeout | null = null;

	constructor(pool: Pool, config?: Partial<RetentionConfig>) {
		this.pool = pool;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/** Start the automatic cleanup schedule. */
	start(): void {
		const ms = this.config.intervalHours * 60 * 60 * 1000;
		console.log(
			`[DataRetention] Auto-cleanup every ${this.config.intervalHours}h ` +
				`(WAL: ${this.config.walHardLimitDays}d, orphans: ${this.config.orphanTimeoutHours}h)`,
		);

		// Run immediately on start, then on interval
		void this.runCleanup();
		this.interval = setInterval(() => void this.runCleanup(), ms);
	}

	/** Stop the automatic cleanup schedule. */
	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	/** Run all cleanup tasks. Can be called manually. */
	async runCleanup(): Promise<{
		walPruned: number;
		snapshotsPruned: number;
		orphansPruned: number;
	}> {
		const results = { walPruned: 0, snapshotsPruned: 0, orphansPruned: 0 };

		try {
			// 1. Prune terminal WAL rows (completed/failed) older than retention
			const terminalCutoff = new Date(
				Date.now() - this.config.walTerminalRetentionHours * 60 * 60 * 1000,
			);
			const { rowCount: terminalPruned } = await this.pool.query(
				`DELETE FROM store_job_wal
         WHERE event IN ('completed', 'failed')
           AND recorded_at < $1`,
				[terminalCutoff],
			);
			results.walPruned += terminalPruned ?? 0;

			// 2. Hard limit: delete ALL WAL rows older than N days (safety net)
			const hardCutoff = new Date(
				Date.now() - this.config.walHardLimitDays * 24 * 60 * 60 * 1000,
			);
			const { rowCount: hardPruned } = await this.pool.query(
				`DELETE FROM store_job_wal WHERE recorded_at < $1`,
				[hardCutoff],
			);
			results.walPruned += hardPruned ?? 0;

			// 3. Prune orphaned jobs (stuck in non-terminal state for too long)
			const orphanCutoff = new Date(
				Date.now() - this.config.orphanTimeoutHours * 60 * 60 * 1000,
			);
			const { rowCount: orphanPruned } = await this.pool.query(
				`DELETE FROM store_job_wal
         WHERE event NOT IN ('completed', 'failed')
           AND recorded_at < $1
           AND job_id NOT IN (
             SELECT DISTINCT job_id FROM store_job_wal
             WHERE event IN ('completed', 'failed')
           )`,
				[orphanCutoff],
			);
			results.orphansPruned = orphanPruned ?? 0;

			// 4. Keep only last N snapshots
			const { rowCount: snapPruned } = await this.pool.query(
				`DELETE FROM store_snapshots
         WHERE id NOT IN (
           SELECT id FROM store_snapshots
           ORDER BY saved_at DESC
           LIMIT $1
         )`,
				[this.config.maxSnapshots],
			);
			results.snapshotsPruned = snapPruned ?? 0;

			// 5. Prune old usage events (biggest storage consumer)
			const usageCutoff = new Date(
				Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days
			);
			const { rowCount: usagePruned } = await this.pool.query(
				`DELETE FROM store_usage_events WHERE recorded_at < $1`,
				[usageCutoff],
			);
			if (usagePruned && usagePruned > 0) {
				console.log(`[DataRetention] Pruned ${usagePruned} old usage events`);
			}

			// 6. VACUUM (non-blocking) to reclaim space
			// Note: Supabase auto-vacuums, but this helps after large deletes
			await this.pool
				.query("VACUUM (VERBOSE, ANALYZE) store_job_wal")
				.catch(() => {});
			await this.pool
				.query("VACUUM (VERBOSE, ANALYZE) store_usage_events")
				.catch(() => {});

			const total =
				results.walPruned + results.snapshotsPruned + results.orphansPruned;
			if (total > 0) {
				console.log(
					`[DataRetention] Cleanup: ${results.walPruned} WAL rows, ` +
						`${results.orphansPruned} orphans, ${results.snapshotsPruned} snapshots`,
				);
			}
		} catch (err: any) {
			console.error("[DataRetention] Cleanup failed:", err.message);
		}

		return results;
	}

	/** Get current storage stats. */
	async getStorageStats(): Promise<{
		walRows: number;
		walSizeMB: number;
		snapshotCount: number;
		snapshotSizeMB: number;
		usageRows?: number;
		usageSizeMB?: number;
		totalSizeMB: number;
	}> {
		try {
			const { rows } = await this.pool.query(`
        SELECT
          (SELECT COUNT(*) FROM store_job_wal) AS wal_rows,
          (SELECT pg_total_relation_size('store_job_wal') / 1024.0 / 1024.0) AS wal_size_mb,
          (SELECT COUNT(*) FROM store_snapshots) AS snapshot_count,
          (SELECT pg_total_relation_size('store_snapshots') / 1024.0 / 1024.0) AS snapshot_size_mb,
          (SELECT COUNT(*) FROM store_usage_events) AS usage_rows,
          (SELECT pg_total_relation_size('store_usage_events') / 1024.0 / 1024.0) AS usage_size_mb
      `);

			const row = rows[0];
			return {
				walRows: Number(row.wal_rows),
				walSizeMB: Number(Number(row.wal_size_mb).toFixed(2)),
				snapshotCount: Number(row.snapshot_count),
				snapshotSizeMB: Number(Number(row.snapshot_size_mb).toFixed(2)),
				usageRows: Number(row.usage_rows),
				usageSizeMB: Number(Number(row.usage_size_mb).toFixed(2)),
				totalSizeMB: Number(
					(
						Number(row.wal_size_mb) +
						Number(row.snapshot_size_mb) +
						Number(row.usage_size_mb)
					).toFixed(2),
				),
			};
		} catch (err: any) {
			console.error("[DataRetention] Stats query failed:", err.message);
			return {
				walRows: 0,
				walSizeMB: 0,
				snapshotCount: 0,
				snapshotSizeMB: 0,
				totalSizeMB: 0,
			};
		}
	}
}
