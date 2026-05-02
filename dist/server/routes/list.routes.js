"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createListRoutes = void 0;
const express_1 = require("express");
const auth_js_1 = require("../middleware/auth.js");
const createListRoutes = (store) => {
    const router = (0, express_1.Router)();
    router.post("/lpush", (req, res) => {
        const { key, value } = req.body;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        store.lists.lpush(tenantKey, value);
        res.json({ success: true });
    });
    router.post("/rpush", (req, res) => {
        const { key, value } = req.body;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        store.lists.rpush(tenantKey, value);
        res.json({ success: true });
    });
    router.get("/lpop", (req, res) => {
        const { key } = req.query;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        res.json({ value: store.lists.lpop(tenantKey) });
    });
    return router;
};
exports.createListRoutes = createListRoutes;
