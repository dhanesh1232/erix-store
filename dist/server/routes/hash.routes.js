import { Router } from "express";
import { getTenantKey } from "../middleware/auth.js";
export const createHashRoutes = (store) => {
    const router = Router();
    router.post("/hset", (req, res) => {
        const { key, field, value } = req.body;
        const tenantKey = getTenantKey(req.tenantId, key);
        store.hashes.hset(tenantKey, field, value);
        res.json({ success: true });
    });
    router.get("/hget", (req, res) => {
        const { key, field } = req.query;
        const tenantKey = getTenantKey(req.tenantId, key);
        res.json({ value: store.hashes.hget(tenantKey, field) });
    });
    router.get("/hgetall", (req, res) => {
        const { key } = req.query;
        const tenantKey = getTenantKey(req.tenantId, key);
        res.json({ data: store.hashes.hgetall(tenantKey) });
    });
    return router;
};
