/**
 * UsageMeter
 *
 * Tracks per-tenant event counts in memory and flushes them to Postgres
 * in batches every 10 seconds. Keeps DB writes minimal while capturing
 * full granularity.
 *
 * Events recorded:
 *   cache_set | cache_get | cache_hit | cache_miss | cache_invalidate
 *   job_enqueued | job_claimed | job_completed | job_failed
 *   pubsub_publish | pubsub_subscribe
 *   ratelimit_check | ratelimit_denied
 *   lock_acquired | lock_released
 */

import type { Pool } from "pg";
import type { AnomalyDetector } from "./AnomalyDetector.js";

export type UsageEventType =
	| "cache_set"
	| "cache_get_hit"
	| "cache_get_miss"
	| "cache_invalidate"
	| "job_enqueued"
	| "job_claimed"
	| "job_completed"
	| "job_failed"
	| "pubsub_publish"
	| "ratelimit_check"
	| "ratelimit_denied"
	| "lock_acquired"
	| "lock_released"
	| "semantic_set"
	| "semantic_hit"
	| "semantic_miss";

interface TenantBuffer {
	[event: string]: number;
}

export class UsageMeter {
	/** tenantId → { eventType → count } */
	private buffer = new Map<string, TenantBuffer>();
	private flushInterval: NodeJS.Timeout;
	private pool: Pool | null;
	private anomaly: AnomalyDetector | null;

	constructor(
		pool: Pool | null,
		anomaly: AnomalyDetector | null,
		flushIntervalMs = 10_000,
	) {
		this.pool = pool;
		this.anomaly = anomaly;
		this.flushInterval = setInterval(() => void this.flush(), flushIntervalMs);
	}

	// ─── Public API ────────────────────────────────────────────────────────

	/**
	 * Record one (or more) events for a tenant.
	 */
	record(tenantId: string, event: UsageEventType, count = 1): void {
		if (!tenantId) return;

		if (!this.buffer.has(tenantId)) this.buffer.set(tenantId, {});
		const buf = this.buffer.get(tenantId)!;
		buf[event] = (buf[event] ?? 0) + count;

		// Feed derived rates into anomaly detector (per call, not per flush)
		if (this.anomaly) {
			if (event === "job_failed" || event === "job_completed") {
				// Update anomaly detector with current failure proportion
				const failed = buf["job_failed"] ?? 0;
				const completed = buf["job_completed"] ?? 0;
				const total = failed + completed;
				if (total > 0) {
					this.anomaly.record(tenantId, "job_failure_rate", failed / total);
				}
			}
			if (event === "cache_get_hit" || event === "cache_get_miss") {
				const hits = buf["cache_get_hit"] ?? 0;
				const misses = buf["cache_get_miss"] ?? 0;
				const total = hits + misses;
				if (total > 0) {
					this.anomaly.record(tenantId, "cache_miss_rate", misses / total);
				}
			}
			if (event === "ratelimit_denied") {
				this.anomaly.record(tenantId, "ratelimit_hit_rate", count);
			}
		}
	}

	/**
	 * Return current buffer snapshot for a tenant (for live dashboard reads).
	 */
	snapshot(tenantId: string): TenantBuffer {
		return { ...(this.buffer.get(tenantId) ?? {}) };
	}

	/**
	 * Return all tenant snapshots.
	 */
	allSnapshots(): Record<string, TenantBuffer> {
		const out: Record<string, TenantBuffer> = {};
		for (const [tid, buf] of this.buffer.entries()) {
			out[tid] = { ...buf };
		}
		return out;
	}

	destroy(): void {
		clearInterval(this.flushInterval);
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async flush(): Promise<void> {
		if (!this.pool || this.buffer.size === 0) return;

		const snapshot = new Map(this.buffer);
		this.buffer.clear();

		try {
			const client = await this.pool.connect();
			try {
				await client.query("BEGIN");
				for (const [tenantId, events] of snapshot.entries()) {
					for (const [event, count] of Object.entries(events)) {
						if (count === 0) continue;
						await client.query(
							`INSERT INTO erix_usage_events (tenant_id, event_type, count)
							 VALUES ($1, $2, $3)
							 ON CONFLICT DO NOTHING`,
							[tenantId, event, count],
						);
					}
				}
				await client.query("COMMIT");
			} catch (err) {
				await client.query("ROLLBACK");
				// Restore buffer — don't lose data on transient DB errors
				for (const [tenantId, events] of snapshot.entries()) {
					if (!this.buffer.has(tenantId)) this.buffer.set(tenantId, {});
					const buf = this.buffer.get(tenantId)!;
					for (const [event, count] of Object.entries(events)) {
						buf[event] = (buf[event] ?? 0) + count;
					}
				}
				console.error("[UsageMeter] Flush failed, buffer restored:", err);
			} finally {
				client.release();
			}
		} catch (err) {
			console.error("[UsageMeter] DB connection error during flush:", err);
		}
	}
}
