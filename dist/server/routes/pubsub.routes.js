import { Router } from "express";
import { getTenantKey } from "../middleware/auth.js";
export const createPubSubRoutes = (pubsub) => {
    const router = Router();
    /** Publish a message to a channel */
    router.post("/publish", (req, res) => {
        const { channel, message } = req.body;
        const tenantChannel = getTenantKey(req.tenantId, channel);
        pubsub.publish(tenantChannel, message);
        res.json({ success: true });
    });
    /**
     * Real-time subscription via Server-Sent Events.
     * The client connects once and receives all messages published to `channel`.
     *
     * GET /pubsub/:channel/stream
     *
     * curl -N -H "x-erix-key: KEY" -H "x-tenant-id: TENANT" \
     *      https://erix.example.com/pubsub/alerts/stream
     */
    router.get("/:channel/stream", (req, res) => {
        const { channel } = req.params;
        const tenantChannel = getTenantKey(req.tenantId, channel);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // prevent Nginx from buffering
        res.flushHeaders();
        // Keep connection alive through proxies / load balancers
        const keepAlive = setInterval(() => res.write(": ping\n\n"), 30_000);
        const handler = (message) => {
            res.write(`data: ${JSON.stringify(message)}\n\n`);
        };
        pubsub.subscribe(tenantChannel, handler);
        req.on("close", () => {
            clearInterval(keepAlive);
            pubsub.unsubscribe(tenantChannel, handler);
        });
    });
    /**
     * Legacy HTTP subscribe stub — kept for backwards compat.
     * For real-time delivery use GET /:channel/stream instead.
     */
    router.post("/subscribe", (req, res) => {
        const { channel } = req.body;
        const tenantChannel = getTenantKey(req.tenantId, channel);
        console.log(`[PubSub] Legacy subscribe request for ${tenantChannel}`);
        res.json({
            success: true,
            message: "Use GET /pubsub/:channel/stream for real-time delivery",
        });
    });
    return router;
};
