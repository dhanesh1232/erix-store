/**
 * @file src/services/JobWAL.ts
 * @module ErixStore/JobWAL
 * @responsibility Write-Ahead Log for the job queue.
 *
 * **WHY THIS EXISTS:**
 * The 5-minute snapshot cadence in PersistenceManager creates a gap where
 * active and waiting jobs can be lost if erix-store crashes. The WAL closes
 * that gap by writing every job state transition to Postgres immediately,
 * as a sequence of immutable mutation rows.
 *
 * **SCHEMA:**
 *   erix_job_wal (
 *     id         BIGSERIAL PRIMARY KEY,
 *     job_id     TEXT NOT NULL,
 *     queue_name TEXT NOT NULL,
 *     event      TEXT NOT NULL,    -- 'enqueued' | 'claimed' | 'completed' | 'failed' | 'retry'
 *     data       JSONB,            -- full job snapshot at the time of the event
 *     recorded_at TIMESTAMPTZ DEFAULT now()
 *   )
 *
 * **REPLAY STRATEGY:**
 * On restart, replay() reads all WAL rows that haven't been finalized
 * (no 'completed' or 'failed' terminal event) and rebuilds the in-memory queue.
 * This is idempotent — replaying the same WAL twice is safe.
 *
 * **PRUNING:**
 * Finalized WAL rows (completed/failed) older than 24 hours are pruned on each
 * startAutoSave() tick to prevent unbounded Postgres growth.
 */

import type { Pool } from "pg";
import type { Job } from "./JobQueueV2.js";

// ─── WAL Event Types ─────────────────────────────────────────────────────────

export type WalEvent =
	| "enqueued"
	| "claimed"
	| "completed"
	| "failed"
	| "retry"
	| "delayed";

/** Terminal events — jobs in these states are excluded from WAL replay. */
const TERMINAL_EVENTS: WalEvent[] = ["completed", "failed"];

// ─── Schema ──────────────────────────────────────────────────────────────────

const CREATE_WAL_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS erix_job_wal (
    id          BIGSERIAL    PRIMARY KEY,
    job_id      TEXT         NOT NULL,
    queue_name  TEXT         NOT NULL,
    event       TEXT         NOT NULL,
    data        JSONB        NOT NULL,
    recorded_at TIMESTAMPTZ  NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_erix_job_wal_job_id ON erix_job_wal (job_id);
  CREATE INDEX IF NOT EXISTS idx_erix_job_wal_event  ON erix_job_wal (event);
`;

// ─── JobWAL ──────────────────────────────────────────────────────────────────

export class JobWAL {
	private pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	/** Ensure the WAL table exists. Called once during bootstrap. */
	async initialize(): Promise<void> {
		await this.pool.query(CREATE_WAL_TABLE_SQL);
		console.log("[JobWAL] WAL table ready ✓");
	}

	/**
	 * Append a mutation to the WAL.
	 * Fire-and-forget from the caller's perspective — errors are logged, not thrown,
	 * so a WAL write failure never blocks the in-memory queue operation.
	 */
	async log(event: WalEvent, job: Job): Promise<void> {
		try {
			await this.pool.query(
				`INSERT INTO erix_job_wal (job_id, queue_name, event, data)
         VALUES ($1, $2, $3, $4)`,
				[job.id, job.queueName, event, JSON.stringify(job)],
			);
		} catch (err: any) {
			// Non-fatal: the in-memory queue is still updated. Log and continue.
			console.error(`[JobWAL] Failed to log ${event} for job ${job.id}:`, err.message);
		}
	}

	/**
	 * Replay the WAL to reconstruct the in-memory queue state after a restart.
	 *
	 * Strategy:
	 * 1. Find all job_ids that have no terminal event (not completed/failed).
	 * 2. For each surviving job, get the latest WAL row and return its data snapshot.
	 * 3. The caller (JobQueueV2) re-inserts these jobs into the appropriate in-memory bucket.
	 *
	 * @returns Array of job snapshots to be re-hydrated into the queue.
	 */
	async replay(): Promise<Job[]> {
		try {
			const { rows } = await this.pool.query<{ data: Job }>(`
        SELECT DISTINCT ON (job_id)
          job_id,
          data
        FROM erix_job_wal
        WHERE job_id NOT IN (
          SELECT DISTINCT job_id
          FROM erix_job_wal
          WHERE event = ANY($1)
        )
        ORDER BY job_id, id DESC
      `, [TERMINAL_EVENTS]);

			const jobs: Job[] = rows.map((r) => {
				const job = r.data;
				// Rehydrate Date fields serialized as ISO strings
				if (job.runAt) job.runAt = new Date(job.runAt);
				if (job.createdAt) job.createdAt = new Date(job.createdAt);
				if (job.startedAt) job.startedAt = new Date(job.startedAt);
				if (job.heartbeatAt) job.heartbeatAt = new Date(job.heartbeatAt);
				// Active jobs that were mid-execution when the crash happened
				// are reset to 'waiting' so they get retried.
				if (job.status === "active") {
					job.status = "waiting";
					job.startedAt = undefined;
					console.warn(
						`[JobWAL] Resetting zombie job ${job.id} (was active at crash) → waiting`,
					);
				}
				return job;
			});

			console.log(`[JobWAL] Replayed ${jobs.length} surviving jobs ✓`);
			return jobs;
		} catch (err: any) {
			console.error("[JobWAL] Replay failed — starting with empty queue:", err.message);
			return [];
		}
	}

	/**
	 * Prune terminal WAL rows older than the given retention period.
	 * Called periodically from PersistenceManager to prevent unbounded table growth.
	 *
	 * @param retentionMs - Keep finalized rows for this many ms (default: 24h)
	 */
	async prune(retentionMs: number = 24 * 60 * 60 * 1000): Promise<number> {
		try {
			const cutoff = new Date(Date.now() - retentionMs);
			const { rowCount } = await this.pool.query(
				`DELETE FROM erix_job_wal
         WHERE event = ANY($1)
           AND recorded_at < $2`,
				[TERMINAL_EVENTS, cutoff],
			);
			const pruned = rowCount ?? 0;
			if (pruned > 0) {
				console.log(`[JobWAL] Pruned ${pruned} finalized WAL rows`);
			}
			return pruned;
		} catch (err: any) {
			console.error("[JobWAL] Prune failed:", err.message);
			return 0;
		}
	}
}
