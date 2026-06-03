import { Router } from "express";
import type { ErixStore } from "../../core/Store.js";
import { getTenantKey } from "../middleware/auth.js";

/**
 * List operations. Backed by a doubly-linked list — LPUSH/RPUSH/LPOP/RPOP
 * are O(1); LRANGE/LINDEX/LREM/LTRIM are O(n) but walk from the nearer end.
 *
 * Routes return standard result shapes:
 *   LPUSH/RPUSH → { length } (new list length)
 *   LPOP/RPOP   → { value }
 *   LLEN        → { length }
 *   LINDEX      → { value }
 *   LRANGE      → { values }
 *   LREM        → { removed }
 *   LTRIM       → { success: true }
 */
export const createListRoutes = (store: ErixStore) => {
  const router = Router();

  // Drop the key from the registry when its list is fully drained,
  // so the same key can be re-bound to a different type later.
  const cleanupIfEmpty = (tenantKey: string) => {
    if (!store.lists.has(tenantKey)) {
      store.types.unregister(tenantKey);
    }
  };

  router.post("/lpush", (req, res, next) => {
    try {
      const { key, value } = req.body;
      const tenantKey = getTenantKey(req.tenantId, key);
      store.reserveKey(tenantKey, "list");
      const length = store.lists.lpush(tenantKey, value);
      res.json({ success: true, length });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rpush", (req, res, next) => {
    try {
      const { key, value } = req.body;
      const tenantKey = getTenantKey(req.tenantId, key);
      store.reserveKey(tenantKey, "list");
      const length = store.lists.rpush(tenantKey, value);
      res.json({ success: true, length });
    } catch (err) {
      next(err);
    }
  });

  router.get("/lpop", (req, res, next) => {
    try {
      const { key } = req.query;
      const tenantKey = getTenantKey(req.tenantId, key as string);
      if (store.isExpired(tenantKey)) {
        return res.json({ value: null });
      }
      store.types.assertType(tenantKey, "list");
      const value = store.lists.lpop(tenantKey);
      cleanupIfEmpty(tenantKey);
      res.json({ value });
    } catch (err) {
      next(err);
    }
  });

  router.get("/rpop", (req, res, next) => {
    try {
      const { key } = req.query;
      const tenantKey = getTenantKey(req.tenantId, key as string);
      if (store.isExpired(tenantKey)) {
        return res.json({ value: null });
      }
      store.types.assertType(tenantKey, "list");
      const value = store.lists.rpop(tenantKey);
      cleanupIfEmpty(tenantKey);
      res.json({ value });
    } catch (err) {
      next(err);
    }
  });

  router.get("/llen", (req, res, next) => {
    try {
      const { key } = req.query;
      const tenantKey = getTenantKey(req.tenantId, key as string);
      if (store.isExpired(tenantKey)) {
        return res.json({ length: 0 });
      }
      store.types.assertType(tenantKey, "list");
      res.json({ length: store.lists.llen(tenantKey) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/lindex", (req, res, next) => {
    try {
      const { key, index } = req.query;
      const tenantKey = getTenantKey(req.tenantId, key as string);
      if (store.isExpired(tenantKey)) {
        return res.json({ value: null });
      }
      store.types.assertType(tenantKey, "list");
      const idx = Number(index);
      if (!Number.isFinite(idx)) {
        return res.status(400).json({ error: "index must be an integer" });
      }
      res.json({ value: store.lists.lindex(tenantKey, idx) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/lrange", (req, res, next) => {
    try {
      const { key, start, stop } = req.query;
      const tenantKey = getTenantKey(req.tenantId, key as string);
      if (store.isExpired(tenantKey)) {
        return res.json({ values: [] });
      }
      store.types.assertType(tenantKey, "list");
      const s = Number(start);
      const e = Number(stop);
      if (!Number.isFinite(s) || !Number.isFinite(e)) {
        return res
          .status(400)
          .json({ error: "start and stop must be integers" });
      }
      res.json({ values: store.lists.lrange(tenantKey, s, e) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/lrem", (req, res, next) => {
    try {
      const { key, count, value } = req.body;
      const tenantKey = getTenantKey(req.tenantId, key);
      if (store.isExpired(tenantKey)) {
        return res.json({ removed: 0 });
      }
      store.types.assertType(tenantKey, "list");
      const removed = store.lists.lrem(tenantKey, Number(count), value);
      cleanupIfEmpty(tenantKey);
      res.json({ removed });
    } catch (err) {
      next(err);
    }
  });

  router.post("/ltrim", (req, res, next) => {
    try {
      const { key, start, stop } = req.body;
      const tenantKey = getTenantKey(req.tenantId, key);
      if (store.isExpired(tenantKey)) {
        return res.json({ success: true });
      }
      store.types.assertType(tenantKey, "list");
      store.lists.ltrim(tenantKey, Number(start), Number(stop));
      cleanupIfEmpty(tenantKey);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
