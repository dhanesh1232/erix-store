import { Router } from "express";
import { ErixStore } from "../../core/Store.js";
import { getTenantKey } from "../middleware/auth.js";

export const createSetRoutes = (store: ErixStore) => {
  const router = Router();

  // Sets
  router.post("/sadd", (req, res) => {
    const { key, value } = req.body;
    const tenantKey = getTenantKey((req as any).tenantId, key);
    const added = store.sets.sadd(tenantKey, value);
    res.json({ added });
  });

  router.get("/smembers", (req, res) => {
    const { key } = req.query;
    const tenantKey = getTenantKey((req as any).tenantId, key as string);
    res.json({ members: store.sets.smembers(tenantKey) });
  });

  // Sorted Sets
  router.post("/zadd", (req, res) => {
    const { key, score, value } = req.body;
    const tenantKey = getTenantKey((req as any).tenantId, key);
    const added = store.sortedSets.zadd(tenantKey, score, value);
    res.json({ added });
  });

  router.get("/zrange", (req, res) => {
    const { key, start, stop } = req.query;
    const tenantKey = getTenantKey((req as any).tenantId, key as string);
    res.json({ members: store.sortedSets.zrange(tenantKey, Number(start), Number(stop)) });
  });

  return router;
};
