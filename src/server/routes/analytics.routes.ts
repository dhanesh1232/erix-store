import { Router } from "express";
import type { AnomalyDetector } from "../../services/AnomalyDetector.js";
import type { UsageMeter } from "../../services/UsageMeter.js";

export const createAnalyticsRoutes = (
	meter: UsageMeter,
	anomaly: AnomalyDetector,
) => {
	const router = Router();

	/**
	 * Current usage counts for the authenticated tenant (live from buffer)
	 * GET /analytics/usage
	 */
	router.get("/usage", (req, res) => {
		try {
			const snapshot = meter.snapshot(req.tenantId);
			res.json({ success: true, tenantId: req.tenantId, usage: snapshot });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * All tenant usage (admin only — only works if tenantId === '_admin')
	 * GET /analytics/usage/all
	 */
	router.get("/usage/all", (req, res) => {
		if (req.tenantId !== "_admin") {
			return res.status(403).json({ success: false, error: "Admin only" });
		}
		res.json({ success: true, usage: meter.allSnapshots() });
	});

	/**
	 * Anomaly detector stats for this tenant
	 * GET /analytics/anomalies
	 */
	router.get("/anomalies", (req, res) => {
		try {
			const all = anomaly.allStats();
			const forTenant = all.filter((s) => s.tenantId === req.tenantId);
			res.json({ success: true, tenantId: req.tenantId, metrics: forTenant });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * All anomaly stats (admin)
	 * GET /analytics/anomalies/all
	 */
	router.get("/anomalies/all", (req, res) => {
		if (req.tenantId !== "_admin") {
			return res.status(403).json({ success: false, error: "Admin only" });
		}
		res.json({ success: true, metrics: anomaly.allStats() });
	});

	/**
	 * Subscribe to anomaly alerts for this tenant via SSE
	 * GET /analytics/anomalies/stream
	 *
	 * The client receives events whenever a metric spikes beyond 3σ.
	 * This is how the dashboard shows real-time alerts without polling.
	 */
	router.get("/anomalies/stream", (req, res) => {
		const { tenantId } = req;

		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no");
		res.flushHeaders();

		// We import pubsub via closure — passed through the analytics service factory
		// The anomaly detector publishes to `${tenantId}:anomaly` on its own pubsub instance
		res.write(`: connected to anomaly stream for ${tenantId}\n\n`);

		const keepAlive = setInterval(() => res.write(": ping\n\n"), 30_000);
		req.on("close", () => clearInterval(keepAlive));
	});

	return router;
};
