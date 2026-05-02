"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSetRoutes = void 0;
const express_1 = require("express");
const auth_js_1 = require("../middleware/auth.js");
const createSetRoutes = (store) => {
    const router = (0, express_1.Router)();
    // Sets
    router.post("/sadd", (req, res) => {
        const { key, value } = req.body;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        const added = store.sets.sadd(tenantKey, value);
        res.json({ added });
    });
    router.get("/smembers", (req, res) => {
        const { key } = req.query;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        res.json({ members: store.sets.smembers(tenantKey) });
    });
    // Sorted Sets
    router.post("/zadd", (req, res) => {
        const { key, score, value } = req.body;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        const added = store.sortedSets.zadd(tenantKey, score, value);
        res.json({ added });
    });
    router.get("/zrange", (req, res) => {
        const { key, start, stop } = req.query;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        res.json({ members: store.sortedSets.zrange(tenantKey, Number(start), Number(stop)) });
    });
    return router;
};
exports.createSetRoutes = createSetRoutes;
