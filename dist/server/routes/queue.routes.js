import { Router } from "express";
import { getTenantKey } from "../middleware/auth.js";
export const createQueueRoutes = (queue) => {
    const router = Router();
    router.post("/push", (req, res) => {
        const { queue: queueName, data } = req.body;
        const tenantQueue = getTenantKey(req.tenantId, queueName);
        queue.push(tenantQueue, data);
        res.json({ success: true });
    });
    router.get("/pop", (req, res) => {
        const { queue: queueName } = req.query;
        const tenantQueue = getTenantKey(req.tenantId, queueName);
        res.json({ data: queue.pop(tenantQueue) });
    });
    return router;
};
