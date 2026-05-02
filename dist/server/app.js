"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const auth_js_1 = require("./middleware/auth.js");
const core_routes_js_1 = require("./routes/core.routes.js");
const hash_routes_js_1 = require("./routes/hash.routes.js");
const list_routes_js_1 = require("./routes/list.routes.js");
const set_routes_js_1 = require("./routes/set.routes.js");
const queue_routes_js_1 = require("./routes/queue.routes.js");
const pubsub_routes_js_1 = require("./routes/pubsub.routes.js");
const createApp = (store, queue, pubsub, rateLimiter) => {
    const app = (0, express_1.default)();
    app.use((0, cors_1.default)());
    app.use(express_1.default.json());
    // Health & Stats (Unprotected)
    app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));
    app.get("/stats", (req, res) => res.json({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        store: store.exportAll(), // Be careful with large data in production
    }));
    // Protected Routes
    app.use(auth_js_1.authMiddleware);
    app.use("/core", (0, core_routes_js_1.createCoreRoutes)(store));
    app.use("/hash", (0, hash_routes_js_1.createHashRoutes)(store));
    app.use("/list", (0, list_routes_js_1.createListRoutes)(store));
    app.use("/set", (0, set_routes_js_1.createSetRoutes)(store));
    app.use("/queue", (0, queue_routes_js_1.createQueueRoutes)(queue));
    app.use("/pubsub", (0, pubsub_routes_js_1.createPubSubRoutes)(pubsub));
    // Rate Limit route
    app.post("/ratelimit", async (req, res) => {
        const { key, limit, window } = req.body;
        const tenantId = req.tenantId;
        const result = await rateLimiter.check(`${tenantId}:${key}`, limit, window);
        res.json(result);
    });
    return app;
};
exports.createApp = createApp;
