import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { OOMError, WrongTypeError } from "../core/errors.js";
import type { ErixStore } from "../core/Store.js";
import type { AnomalyDetector } from "../services/AnomalyDetector.js";
import type { AofLog } from "../services/AofLog.js";
import type { CacheService } from "../services/CacheService.js";
import type { ConfigRegistry } from "../services/ConfigRegistry.js";
import type { DistributedLockService } from "../services/DistributedLock.js";
import type { JobQueueV2 } from "../services/JobQueueV2.js";
import type { PriorityQueue } from "../services/PriorityQueue.js";
import type { PubSubService } from "../services/PubSub.js";
import type { RateLimiterService } from "../services/RateLimiter.js";
import type { SemanticCacheService } from "../services/SemanticCacheService.js";
import type { SlowLog } from "../services/SlowLog.js";
import type { UsageMeter } from "../services/UsageMeter.js";
import {
  authMiddleware,
  createAuthMiddleware,
  type AuthMiddlewareOptions,
} from "./middleware/auth.js";
import type { KeyValidator } from "./middleware/keyValidator.js";
import { createMeteringMiddleware } from "./middleware/metering.js";
import { createAnalyticsRoutes } from "./routes/analytics.routes.js";
import { createCacheRoutes } from "./routes/cache.routes.js";
import { createCoreRoutes } from "./routes/core.routes.js";
import { createHashRoutes } from "./routes/hash.routes.js";
import { createListRoutes } from "./routes/list.routes.js";
import { createLockRoutes } from "./routes/lock.routes.js";
import { createPubSubRoutes } from "./routes/pubsub.routes.js";
import { createQueueRoutes } from "./routes/queue.routes.js";
import { createQueueV2Routes } from "./routes/queueV2.routes.js";
import { createRateLimitRoutes } from "./routes/ratelimit.routes.js";
import { createSemanticCacheRoutes } from "./routes/semantic.routes.js";
import { createServerRoutes } from "./routes/server.routes.js";
import { createSetRoutes } from "./routes/set.routes.js";
import { createTxRoutes } from "./routes/tx.routes.js";

export interface AppServices {
  queueV2?: JobQueueV2;
  /** Lightweight priority queue (ENQUEUE/DEQUEUE/...). */
  queue?: PriorityQueue;
  lock?: DistributedLockService;
  cache?: CacheService;
  semantic?: SemanticCacheService;
  meter?: UsageMeter;
  anomaly?: AnomalyDetector;
  /** Slow command log; powers the SLOWLOG verb. */
  slowlog?: SlowLog;
  /** Runtime-tunable parameter catalog; powers CONFIG GET/SET. */
  config?: ConfigRegistry;
  /** Tenant ID authorised to mutate config and trigger BGSAVE. */
  adminTenantId?: string;
  /** Async snapshot trigger; powers BGSAVE. */
  bgsave?: () => Promise<void> | void;
  /** Append-only command log; powers AOF replay + BGREWRITEAOF. */
  aof?: AofLog;
  /**
   * Pre-built key validator to inject into the auth middleware.
   * When omitted the default `authMiddleware` is used (requires
   * `DATABASE_URL` + `ERIX_INTERNAL_KEY` env vars at runtime).
   * Tests should pass a mock/stub validator here to avoid needing
   * a live database connection.
   */
  authValidator?: KeyValidator;
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
  if (services.authValidator) {
    app.use(createAuthMiddleware({ validator: services.authValidator }));
  } else {
    app.use(authMiddleware);
  }

  // Metering middleware — passive, runs after auth so tenantId is set
  if (services.meter) {
    app.use(createMeteringMiddleware(services.meter));
  }

  // Core data structures
  app.use("/core", createCoreRoutes(store));
  app.use("/hash", createHashRoutes(store));
  app.use("/list", createListRoutes(store));
  app.use("/set", createSetRoutes(store));
  app.use("/server", createServerRoutes(store));
  app.use("/pubsub", createPubSubRoutes(pubsub));
  app.use("/ratelimit", createRateLimitRoutes(rateLimiter));

  // Priority queue (separate from /queue/v2 workflow engine)
  if (services.queue) {
    app.use("/q", createQueueRoutes(services.queue));
  }

  // Transactions (MULTI/EXEC) — runs every command in one event-loop tick.
  app.use(
    "/tx",
    createTxRoutes({
      store,
      queue: services.queue,
      pubsub,
      slowlog: services.slowlog,
      config: services.config,
      adminTenantId: services.adminTenantId,
      bgsave: services.bgsave,
      aof: services.aof,
    }),
  );

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

  // ── Global error handler ───────────────────────────────────────────────
  // Routes use try/catch for explicit failures, but synchronous throws
  // (notably WrongTypeError from the type registry) bubble up here.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof WrongTypeError) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (err instanceof OOMError) {
      return res.status(507).json({ error: err.message, code: err.code });
    }
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  });

  return app;
};
