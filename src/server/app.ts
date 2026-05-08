import cors from "cors";
import express from "express";
import type { ErixStore } from "../core/Store.js";
import type { AnomalyDetector } from "../services/AnomalyDetector.js";
import type { CacheService } from "../services/CacheService.js";
import type { DistributedLockService } from "../services/DistributedLock.js";
import type { JobQueueV2 } from "../services/JobQueueV2.js";
import type { PubSubService } from "../services/PubSub.js";
import type { RateLimiterService } from "../services/RateLimiter.js";
import type { SemanticCacheService } from "../services/SemanticCacheService.js";
import type { UsageMeter } from "../services/UsageMeter.js";
import { authMiddleware } from "./middleware/auth.js";
import { createMeteringMiddleware } from "./middleware/metering.js";
import { createAnalyticsRoutes } from "./routes/analytics.routes.js";
import { createCacheRoutes } from "./routes/cache.routes.js";
import { createCoreRoutes } from "./routes/core.routes.js";
import { createHashRoutes } from "./routes/hash.routes.js";
import { createListRoutes } from "./routes/list.routes.js";
import { createLockRoutes } from "./routes/lock.routes.js";
import { createPubSubRoutes } from "./routes/pubsub.routes.js";
import { createQueueV2Routes } from "./routes/queueV2.routes.js";
import { createRateLimitRoutes } from "./routes/ratelimit.routes.js";
import { createSemanticCacheRoutes } from "./routes/semantic.routes.js";
import { createSetRoutes } from "./routes/set.routes.js";

export interface AppServices {
	queueV2?: JobQueueV2;
	lock?: DistributedLockService;
	cache?: CacheService;
	semantic?: SemanticCacheService;
	meter?: UsageMeter;
	anomaly?: AnomalyDetector;
}

export const createApp = (
	store: ErixStore,
	pubsub: PubSubService,
	rateLimiter: RateLimiterService,
	services: AppServices = {},
) => {
	const app = express();

	app.use(cors());
	app.use(express.json({ limit: "2mb" }));

	// Health (unprotected — needed by monitoring/load-balancers)
	app.get("/health", (_req, res) =>
		res.json({ status: "ok", uptime: process.uptime() }),
	);

	// ── Protected Routes ────────────────────────────────────────────────────
	app.use(authMiddleware);

	// Metering middleware — passive, runs after auth so tenantId is set
	if (services.meter) {
		app.use(createMeteringMiddleware(services.meter));
	}

	// Core data structures
	app.use("/core", createCoreRoutes(store));
	app.use("/hash", createHashRoutes(store));
	app.use("/list", createListRoutes(store));
	app.use("/set", createSetRoutes(store));
	app.use("/pubsub", createPubSubRoutes(pubsub));
	app.use("/ratelimit", createRateLimitRoutes(rateLimiter));

	// Enhanced services (v2)
	if (services.queueV2) {
		app.use("/queue/v2", createQueueV2Routes(services.queueV2));
	}
	if (services.lock) {
		app.use("/lock", createLockRoutes(services.lock));
	}
	if (services.cache) {
		app.use("/cache", createCacheRoutes(services.cache));
	}

	// AI layer
	if (services.semantic) {
		app.use("/semantic", createSemanticCacheRoutes(services.semantic));
	}

	// Analytics + Anomaly detection
	if (services.meter && services.anomaly) {
		app.use(
			"/analytics",
			createAnalyticsRoutes(services.meter, services.anomaly),
		);
	}

	// Platform stats (process-level, protected)
	app.get("/stats", (_req, res) =>
		res.json({
			uptime: process.uptime(),
			memory: process.memoryUsage(),
		}),
	);

	return app;
};
