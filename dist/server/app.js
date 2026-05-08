import cors from "cors";
import express from "express";
import { authMiddleware } from "./middleware/auth.js";
import { createCacheRoutes } from "./routes/cache.routes.js";
import { createCoreRoutes } from "./routes/core.routes.js";
import { createHashRoutes } from "./routes/hash.routes.js";
import { createListRoutes } from "./routes/list.routes.js";
import { createLockRoutes } from "./routes/lock.routes.js";
import { createPubSubRoutes } from "./routes/pubsub.routes.js";
import { createQueueV2Routes } from "./routes/queueV2.routes.js";
import { createRateLimitRoutes } from "./routes/ratelimit.routes.js";
import { createSetRoutes } from "./routes/set.routes.js";
export const createApp = (store, pubsub, rateLimiter, enhanced) => {
    const app = express();
    app.use(cors());
    app.use(express.json());
    // Health & Stats (Unprotected)
    app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));
    app.get("/stats", (_req, res) => res.json({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        store: store.exportAll(), // Be careful with large data in production
    }));
    // Protected Routes
    app.use(authMiddleware);
    app.use("/core", createCoreRoutes(store));
    app.use("/hash", createHashRoutes(store));
    app.use("/list", createListRoutes(store));
    app.use("/set", createSetRoutes(store));
    app.use("/pubsub", createPubSubRoutes(pubsub));
    app.use("/ratelimit", createRateLimitRoutes(rateLimiter));
    // Enhanced services (v2)
    if (enhanced?.queueV2) {
        app.use("/queue/v2", createQueueV2Routes(enhanced.queueV2));
    }
    if (enhanced?.lock) {
        app.use("/lock", createLockRoutes(enhanced.lock));
    }
    if (enhanced?.cache) {
        app.use("/cache", createCacheRoutes(enhanced.cache));
    }
    // Rate Limit route
    app.post("/ratelimit", async (req, res) => {
        const { key, limit, window } = req.body;
        const result = await rateLimiter.check(`${req.tenantId}:${key}`, limit, window);
        res.json(result);
    });
    return app;
};
