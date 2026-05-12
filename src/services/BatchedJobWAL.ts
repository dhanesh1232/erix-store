/**
 * @file src/services/BatchedJobWAL.ts
 * @module ErixStore/BatchedJobWAL
 * @responsibility Batched Write-Ahead Log for the job queue.
 *
 * **WHY THIS EXISTS:**
 * The original JobWAL issues one INSERT per mutation, which at 1000 jobs/sec
 * saturates the Postgres connection pool. BatchedJobWAL buffers mutations in
 * memory and flushes them as a single multi-row INSERT, reducing Postgres
 * round-trips from 1000/sec to <20/sec under sustained load.
 *
 * **FLUSH TRIGGERS:**
 *   - Buffer reaches 100 entries (maxBufferSize)
 *   - 50ms elapsed since the first buffered entry (maxBufferAgeMs)
 *   - Explicit flush() call (graceful shutdown)
 *
 * **OVERFLOW PROTECTION:**
 *   Buffer is capped at 10,000 entries. If Postgres is down and the buffer
 *   fills, new log() calls are rejected (throw) to signal durability degradation.
 *
 * **RETRY STRATEGY:**
 *   On Postgres failure during flush, retry 3 times with 100ms backoff.
 *   If all retries fail, entries remain in the buffer for the next flush cycle.
 *
 * **SCHEMA (unchanged from JobWAL):**
 *   erix_job_wal (
 *     id          BIGSERIAL PRIMARY KEY,
 *     job_id      TEXT NOT NULL,
 *     queue_name  TEXT NOT NULL,
 *     event       TEXT NOT NULL,
 *     data        JSONB NOT NULL,
 *     recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
 *   )
 *
 * @requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
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

// ─── Internal Types ──────────────────────────────────────────────────────────

interface WalEntry {
	jobId: string;
	queueName: string;
	event: WalEvent;
	data: string; // JSON-serialized Job
}

export interface BatchedJobWALOptions {
	/** Max entries before triggering a flush. Default: 100. */
	maxBufferSize?: number;
	/** Max ms since first buffered entry before triggering a flush. Default: 50. */
	maxBufferAgeMs?: number;
	/** Absolute cap on buffer size. Rejects new entries above this. Default: 10,000. */
	maxBufferCap?: number;
	/** Number of retry attempts on flush failure. Default: 3. */
	maxRetries?: number;
	/** Backoff delay in ms between retries. Default: 100. */
	retryBackoffMs?: number;
}

// ─── BatchedJobWAL ───────────────────────────────────────────────────────────

export class BatchedJobWAL {
	private pool: Pool;
	private buffer: WalEntry[] = [];
	private flushTimer: NodeJS.Timeout | null = null;
	private flushing = false;

	// Configuration
	private readonly maxBufferSize: number;
	private readonly maxBufferAgeMs: number;
	private readonly maxBufferCap: number;
	private readonly maxRetries: number;
	private readonly retryBackoffMs: number;

	constructor(pool: Pool, options?: BatchedJobWALOptions) {
		this.pool = pool;
		this.maxBufferSize = options?.maxBufferSize ?? 100;
		this.maxBufferAgeMs = options?.maxBufferAgeMs ?? 50;
		this.maxBufferCap = options?.maxBufferCap ?? 10_000;
		this.maxRetries = options?.maxRetries ?? 3;
		this.retryBackoffMs = options?.retryBackoffMs ?? 100;
	}

	// ─── Public API ────────────────────────────────────────────────────────────

	/** Ensure the WAL table exists. Called once during bootstrap. */
	async initialize(): Promise<void> {
		await this.pool.query(CREATE_WAL_TABLE_SQL);
		console.log("[BatchedJobWAL] WAL table ready ✓");
	}

	/**
	 * Buffer a mutation. Triggers flush if buffer reaches maxBufferSize.
	 * Throws if buffer is at capacity (maxBufferCap) to signal durability degradation.
	 *
	 * @requirements 3.1, 3.4
	 */
	async log(event: WalEvent, job: Job): Promise<void> {
		if (this.buffer.length >= this.maxBufferCap) {
			throw new Error(
				`[BatchedJobWAL] Buffer overflow: ${this.buffer.length} entries buffered (cap: ${this.maxBufferCap}). ` +
					`Postgres may be unreachable. WAL durability degraded.`,
			);
		}

		const entry: WalEntry = {
			jobId: job.id,
			queueName: job.queueName,
			event,
			data: JSON.stringify(job),
		};

		this.buffer.push(entry);

		// Start the age timer on the first buffered entry
		if (this.buffer.length === 1) {
			this.startFlushTimer();
		}

		// Flush immediately if buffer is full
		if (this.buffer.length >= this.maxBufferSize) {
			await this.flush();
		}
	}

	/**
	 * Force flush all buffered entries to Postgres.
	 * Used for graceful shutdown and when buffer reaches maxBufferSize.
	 * Retries up to maxRetries times with backoff on failure.
	 *
	 * @requirements 3.2, 3.3, 3.5
	 */
	async flush(): Promise<void> {
		this.clearFlushTimer();

		if (this.buffer.length === 0) return;

		// Prevent concurrent flushes — take a snapshot of the buffer
		if (this.flushing) return;
		this.flushing = true;

		const entries = this.buffer.splice(0);

		try {
			await this.flushWithRetry(entries);
		} catch (err: any) {
			// All retries exhausted — put entries back at the front of the buffer
			// so they'll be retried on the next flush cycle.
			this.buffer.unshift(...entries);
			console.error(
				`[BatchedJobWAL] Flush failed after ${this.maxRetries} retries: ${err.message}. ` +
					`${entries.length} entries returned to buffer (total: ${this.buffer.length}).`,
			);
		} finally {
			this.flushing = false;

			// If there are still entries in the buffer (from new log() calls during flush),
			// restart the timer.
			if (this.buffer.length > 0) {
				this.startFlushTimer();
			}
		}
	}

	/**
	 * Replay surviving jobs (same strategy as JobWAL).
	 * Reads all WAL rows that haven't been finalized and returns their latest snapshot.
	 */
	async replay(): Promise<Job[]> {
		try {
			const { rows } = await this.pool.query<{ data: Job }>(
				`
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
			`,
				[TERMINAL_EVENTS],
			);

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
						`[BatchedJobWAL] Resetting zombie job ${job.id} (was active at crash) → waiting`,
					);
				}
				return job;
			});

			console.log(`[BatchedJobWAL] Replayed ${jobs.length} surviving jobs ✓`);
			return jobs;
		} catch (err: any) {
			console.error(
				"[BatchedJobWAL] Replay failed — starting with empty queue:",
				err.message,
			);
			return [];
		}
	}

	/**
	 * Prune terminal WAL rows older than the given retention period.
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
				console.log(`[BatchedJobWAL] Pruned ${pruned} finalized WAL rows`);
			}
			return pruned;
		} catch (err: any) {
			console.error("[BatchedJobWAL] Prune failed:", err.message);
			return 0;
		}
	}

	/** Get the current number of buffered entries (for monitoring/testing). */
	get bufferSize(): number {
		return this.buffer.length;
	}

	/** Stop the flush timer. Call during shutdown after flush(). */
	destroy(): void {
		this.clearFlushTimer();
	}

	// ─── Private Helpers ───────────────────────────────────────────────────────

	/**
	 * Execute the multi-row INSERT with retry logic.
	 * Retries up to maxRetries times with retryBackoffMs delay between attempts.
	 *
	 * @requirements 3.3, 3.6
	 */
	private async flushWithRetry(entries: WalEntry[]): Promise<void> {
		let lastError: Error | null = null;

		for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
			try {
				await this.executeBatchInsert(entries);
				return; // Success
			} catch (err: any) {
				lastError = err;
				console.warn(
					`[BatchedJobWAL] Flush attempt ${attempt}/${this.maxRetries} failed: ${err.message}`,
				);
				if (attempt < this.maxRetries) {
					await this.sleep(this.retryBackoffMs * attempt);
				}
			}
		}

		throw lastError;
	}

	/**
	 * Build and execute a single multi-row INSERT statement.
	 * Uses parameterized query to prevent SQL injection.
	 *
	 * Generated SQL:
	 *   INSERT INTO erix_job_wal (job_id, queue_name, event, data)
	 *   VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ...
	 *
	 * @requirements 3.3
	 */
	private async executeBatchInsert(entries: WalEntry[]): Promise<void> {
		if (entries.length === 0) return;

		const COLS_PER_ROW = 4;
		const valuePlaceholders: string[] = [];
		const params: (string | WalEvent)[] = [];

		for (let i = 0; i < entries.length; i++) {
			const offset = i * COLS_PER_ROW;
			valuePlaceholders.push(
				`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`,
			);
			params.push(
				entries[i].jobId,
				entries[i].queueName,
				entries[i].event,
				entries[i].data,
			);
		}

		const sql = `INSERT INTO erix_job_wal (job_id, queue_name, event, data) VALUES ${valuePlaceholders.join(", ")}`;
		await this.pool.query(sql, params);
	}

	/** Start the flush timer (50ms from first buffered entry). */
	private startFlushTimer(): void {
		if (this.flushTimer !== null) return; // Already running
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, this.maxBufferAgeMs);
	}

	/** Clear the flush timer if running. */
	private clearFlushTimer(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}

	/** Promise-based sleep for retry backoff. */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
