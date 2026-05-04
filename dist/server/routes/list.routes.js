import { Router } from "express";
import { getTenantKey } from "../middleware/auth.js";
export const createListRoutes = (store) => {
    const router = Router();
    router.post("/lpush", (req, res) => {
        const { key, value } = req.body;
        const tenantKey = getTenantKey(req.tenantId, key);
        store.lists.lpush(tenantKey, value);
        res.json({ success: true });
    });
    router.post("/rpush", (req, res) => {
        const { key, value } = req.body;
        const tenantKey = getTenantKey(req.tenantId, key);
        store.lists.rpush(tenantKey, value);
        res.json({ success: true });
    });
    router.get("/lpop", (req, res) => {
        const { key } = req.query;
        const tenantKey = getTenantKey(req.tenantId, key);
        res.json({ value: store.lists.lpop(tenantKey) });
    });
    return router;
};
