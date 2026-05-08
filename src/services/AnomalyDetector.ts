/**
 * AnomalyDetector
 *
 * Monitors per-tenant metrics using a rolling Z-score algorithm.
 * A Z-score > 3 (3 standard deviations from the mean) triggers an alert.
 *
 * Metrics tracked per tenant:
 *   - job_failure_rate     (failed / total_finished per window)
 *   - cache_miss_rate      (misses / total_gets per window)
 *   - queue_depth          (waiting job count)
 *   - ratelimit_hit_rate   (429s / total requests per window)
 *
 * Alerts are published to `{tenantId}:anomaly` on the PubSub bus.
 * The SSE pubsub endpoint delivers them to connected dashboards in real time.
 */

import type { PubSubService } from "./PubSub.js";

export interface MetricSample {
	value: number;
	recordedAt: number; // ms epoch
}

export interface AnomalyAlert {
	tenantId: string;
	metric: string;
	current: number;
	mean: number;
	stddev: number;
	zScore: number;
	message: string;
	detectedAt: string;
}

interface RollingWindow {
	samples: MetricSample[];
	sum: number;
	sumSq: number;
}

export class AnomalyDetector {
	/** tenantId:metric → rolling window */
	private windows = new Map<string, RollingWindow>();
	/** How many samples to keep per metric (default: 288 = 24h at 5min intervals) */
	private readonly windowSize: number;
	/** Z-score threshold for alert (default: 3.0) */
	private readonly threshold: number;
	private interval: NodeJS.Timeout;
	private pubsub: PubSubService;

	constructor(
		pubsub: PubSubService,
		options: { windowSize?: number; thresholdZ?: number; checkIntervalMs?: number } = {},
	) {
		this.pubsub = pubsub;
		this.windowSize = options.windowSize ?? 288;
		this.threshold = options.thresholdZ ?? 3.0;

		// Periodic check — every 5 minutes by default
		this.interval = setInterval(
			() => this.runChecks(),
			options.checkIntervalMs ?? 5 * 60 * 1000,
		);
	}

	// ─── Public API ────────────────────────────────────────────────────────

	/**
	 * Record a metric sample for a tenant. Called by the metering middleware.
	 */
	record(tenantId: string, metric: string, value: number): void {
		const key = `${tenantId}:${metric}`;
		if (!this.windows.has(key)) {
			this.windows.set(key, { samples: [], sum: 0, sumSq: 0 });
		}
		const win = this.windows.get(key)!;
		const sample: MetricSample = { value, recordedAt: Date.now() };

		// Evict oldest if at capacity
		if (win.samples.length >= this.windowSize) {
			const evicted = win.samples.shift()!;
			win.sum -= evicted.value;
			win.sumSq -= evicted.value * evicted.value;
		}

		win.samples.push(sample);
		win.sum += value;
		win.sumSq += value * value;
	}

	/**
	 * Get current stats for a metric.
	 */
	stats(tenantId: string, metric: string): { mean: number; stddev: number; n: number } | null {
		const win = this.windows.get(`${tenantId}:${metric}`);
		if (!win || win.samples.length < 10) return null; // need at least 10 samples
		return computeStats(win);
	}

	/**
	 * All active windows — used by /analytics/anomalies endpoint.
	 */
	allStats(): Array<{ tenantId: string; metric: string; mean: number; stddev: number; n: number }> {
		const result = [];
		for (const [key, win] of this.windows.entries()) {
			if (win.samples.length < 10) continue;
			const [tenantId, ...metricParts] = key.split(":");
			const metric = metricParts.join(":");
			result.push({ tenantId, metric, ...computeStats(win) });
		}
		return result;
	}

	destroy(): void {
		clearInterval(this.interval);
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private runChecks(): void {
		for (const [key, win] of this.windows.entries()) {
			if (win.samples.length < 10) continue; // not enough data

			const latest = win.samples[win.samples.length - 1].value;
			const stats = computeStats(win);
			if (stats.stddev === 0) continue;

			const z = Math.abs(latest - stats.mean) / stats.stddev;
			if (z < this.threshold) continue;

			const [tenantId, ...metricParts] = key.split(":");
			const metric = metricParts.join(":");

			const alert: AnomalyAlert = {
				tenantId,
				metric,
				current: latest,
				mean: Math.round(stats.mean * 1000) / 1000,
				stddev: Math.round(stats.stddev * 1000) / 1000,
				zScore: Math.round(z * 100) / 100,
				message: buildMessage(metric, latest, stats.mean, z),
				detectedAt: new Date().toISOString(),
			};

			// Publish to tenant-specific channel — SSE clients get it in real time
			this.pubsub.publish(`${tenantId}:anomaly`, alert as unknown as object);
			console.warn(`[Anomaly] ${tenantId} | ${metric} | z=${z.toFixed(2)} | ${alert.message}`);
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeStats(win: RollingWindow): { mean: number; stddev: number; n: number } {
	const n = win.samples.length;
	const mean = win.sum / n;
	const variance = win.sumSq / n - mean * mean;
	return { mean, stddev: Math.sqrt(Math.max(0, variance)), n };
}

function buildMessage(metric: string, current: number, mean: number, z: number): string {
	const pct = mean > 0 ? Math.round((current / mean - 1) * 100) : 0;
	const dir = current > mean ? "above" : "below";
	const fmt = (v: number) => (v < 1 ? `${(v * 100).toFixed(1)}%` : v.toFixed(0));

	return `${metric} is ${fmt(current)} — ${Math.abs(pct)}% ${dir} normal (z=${z.toFixed(1)})`;
}
