import express from "express";
import cors from "cors";
import { authMiddleware } from "./middleware/auth.js";
import { createCoreRoutes } from "./routes/core.routes.js";
import { createHashRoutes } from "./routes/hash.routes.js";
import { createListRoutes } from "./routes/list.routes.js";
import { createSetRoutes } from "./routes/set.routes.js";
import { createQueueRoutes } from "./routes/queue.routes.js";
import { createPubSubRoutes } from "./routes/pubsub.routes.js";
import { createQueueV2Routes } from "./routes/queueV2.routes.js";
import { createLockRoutes } from "./routes/lock.routes.js";
import { createCacheRoutes } from "./routes/cache.routes.js";
export const createApp = (store, queue, pubsub, rateLimiter, enhanced) => {
    const app = express();
    app.use(cors());
    app.use(express.json());
    // Health & Stats (Unprotected)
    app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));
    app.get("/stats", (req, res) => res.json({
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
    app.use("/queue", createQueueRoutes(queue));
    app.use("/pubsub", createPubSubRoutes(pubsub));
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
        const tenantId = req.tenantId;
        const result = await rateLimiter.check(`${tenantId}:${key}`, limit, window);
        res.json(result);
    });
    return app;
};
