"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createQueueRoutes = void 0;
const express_1 = require("express");
const auth_js_1 = require("../middleware/auth.js");
const createQueueRoutes = (queue) => {
    const router = (0, express_1.Router)();
    router.post("/push", (req, res) => {
        const { queue: queueName, data } = req.body;
        const tenantQueue = (0, auth_js_1.getTenantKey)(req.tenantId, queueName);
        queue.push(tenantQueue, data);
        res.json({ success: true });
    });
    router.get("/pop", (req, res) => {
        const { queue: queueName } = req.query;
        const tenantQueue = (0, auth_js_1.getTenantKey)(req.tenantId, queueName);
        res.json({ data: queue.pop(tenantQueue) });
    });
    return router;
};
exports.createQueueRoutes = createQueueRoutes;
