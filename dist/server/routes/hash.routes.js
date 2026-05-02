"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHashRoutes = void 0;
const express_1 = require("express");
const auth_js_1 = require("../middleware/auth.js");
const createHashRoutes = (store) => {
    const router = (0, express_1.Router)();
    router.post("/hset", (req, res) => {
        const { key, field, value } = req.body;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        store.hashes.hset(tenantKey, field, value);
        res.json({ success: true });
    });
    router.get("/hget", (req, res) => {
        const { key, field } = req.query;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        res.json({ value: store.hashes.hget(tenantKey, field) });
    });
    router.get("/hgetall", (req, res) => {
        const { key } = req.query;
        const tenantKey = (0, auth_js_1.getTenantKey)(req.tenantId, key);
        res.json({ data: store.hashes.hgetall(tenantKey) });
    });
    return router;
};
exports.createHashRoutes = createHashRoutes;
