"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPubSubRoutes = void 0;
const express_1 = require("express");
const auth_js_1 = require("../middleware/auth.js");
const createPubSubRoutes = (pubsub) => {
    const router = (0, express_1.Router)();
    router.post("/publish", (req, res) => {
        const { channel, message } = req.body;
        const tenantChannel = (0, auth_js_1.getTenantKey)(req.tenantId, channel);
        pubsub.publish(tenantChannel, message);
        res.json({ success: true });
    });
    // Note: Subscription via HTTP is usually handled via WebSockets or Webhooks.
    // For now, we'll just log the subscription request.
    router.post("/subscribe", (req, res) => {
        const { channel } = req.body;
        const tenantChannel = (0, auth_js_1.getTenantKey)(req.tenantId, channel);
        console.log(`[PubSub] Subscription request for ${tenantChannel}`);
        res.json({ success: true, message: "Subscription registered (Internal)" });
    });
    return router;
};
exports.createPubSubRoutes = createPubSubRoutes;
