/**
 * Metering Middleware
 *
 * Records one usage event per successful (2xx) response.
 * Route patterns are mapped to event types so billing systems
 * can count by operation rather than raw HTTP hits.
 *
 * Runs AFTER auth — tenantId is guaranteed to be set.
 */

import type { NextFunction, Request, Response } from "express";
import type { UsageEventType, UsageMeter } from "../../services/UsageMeter.js";

/** Map (method, path prefix) → UsageEventType */
const ROUTE_MAP: Array<{
	method: string;
	prefix: string;
	event: UsageEventType;
}> = [
	{ method: "POST", prefix: "/cache", event: "cache_set" },
	{ method: "GET", prefix: "/cache", event: "cache_get_hit" },
	{ method: "DELETE", prefix: "/cache/tags", event: "cache_invalidate" },
	{ method: "POST", prefix: "/semantic/search", event: "semantic_hit" },
	{ method: "POST", prefix: "/semantic", event: "semantic_set" },
	{ method: "POST", prefix: "/queue/v2", event: "job_enqueued" },
	{ method: "POST", prefix: "/queue/v2", event: "job_claimed" },
	{ method: "POST", prefix: "/pubsub/publish", event: "pubsub_publish" },
	{ method: "POST", prefix: "/ratelimit", event: "ratelimit_check" },
	{ method: "POST", prefix: "/lock", event: "lock_acquired" },
];

function classifyRoute(method: string, path: string): UsageEventType | null {
	// Special cases
	if (path.includes("/claim")) return "job_claimed";
	if (path.includes("/complete")) return "job_completed";
	if (path.includes("/fail")) return "job_failed";

	for (const entry of ROUTE_MAP) {
		if (entry.method === method && path.startsWith(entry.prefix)) {
			return entry.event;
		}
	}
	return null;
}

export const createMeteringMiddleware = (meter: UsageMeter) => {
	return (req: Request, res: Response, next: NextFunction): void => {
		// Record on finish so we only count successful responses
		res.on("finish", () => {
			if (res.statusCode >= 200 && res.statusCode < 300) {
				const event = classifyRoute(req.method, req.path);
				if (event) meter.record(req.tenantId, event);
			}
			if (res.statusCode === 429) {
				meter.record(req.tenantId, "ratelimit_denied");
			}
		});
		next();
	};
};
