"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCoreRoutes = void 0;
const express_1 = require("express");
const auth_js_1 = require("../middleware/auth.js");
const createCoreRoutes = (store) => {
    const router = (0, express_1.Router)();
    router.post("/set", (req, res) => {
        const { key, value, ttl } = req.body;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        store.strings.set(tenantKey, value);
        if (ttl) {
            store.ttlManager.set(tenantKey, ttl);
        }
        res.json({ success: true });
    });
    router.get("/get", (req, res) => {
        const { key } = req.query;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        if (store.isExpired(tenantKey)) {
            return res.json({ value: null });
        }
        res.json({ value: store.strings.get(tenantKey) });
    });
    router.delete("/del", (req, res) => {
        const { key } = req.body;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        store.strings.delete(tenantKey);
        store.ttlManager.delete(tenantKey);
        res.json({ success: true });
    });
    return router;
};
exports.createCoreRoutes = createCoreRoutes;
