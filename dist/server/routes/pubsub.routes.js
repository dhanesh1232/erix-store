import { Router } from "express";
import { getTenantKey } from "../middleware/auth.js";
export const createPubSubRoutes = (pubsub) => {
    const router = Router();
    router.post("/publish", (req, res) => {
        const { channel, message } = req.body;
        const tenantChannel = getTenantKey(req.tenantId, channel);
        pubsub.publish(tenantChannel, message);
        res.json({ success: true });
    });
    // Subscription via HTTP is stateless — real-time via WebSockets/SSE in future
    router.post("/subscribe", (req, res) => {
        const { channel } = req.body;
        const tenantChannel = getTenantKey(req.tenantId, channel);
        console.log(`[PubSub] Subscription request for ${tenantChannel}`);
        res.json({ success: true, message: "Subscription registered (Internal)" });
    });
    return router;
};
