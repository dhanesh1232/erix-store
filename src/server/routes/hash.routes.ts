import { Router } from "express";
import { ErixStore } from "../../core/Store.js";
import { getTenantKey } from "../middleware/auth.js";

export const createHashRoutes = (store: ErixStore) => {
  const router = Router();

  router.post("/hset", (req, res) => {
    const { key, field, value } = req.body;
    const tenantKey = getTenantKey((req as any).tenantId, key);
    store.hashes.hset(tenantKey, field, value);
    res.json({ success: true });
  });

  router.get("/hget", (req, res) => {
    const { key, field } = req.query;
    const tenantKey = getTenantKey((req as any).tenantId, key as string);
    res.json({ value: store.hashes.hget(tenantKey, field as string) });
  });

  router.get("/hgetall", (req, res) => {
    const { key } = req.query;
    const tenantKey = getTenantKey((req as any).tenantId, key as string);
    res.json({ data: store.hashes.hgetall(tenantKey) });
  });

  return router;
};
