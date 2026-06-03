import { Router } from "express";
import type { ErixStore } from "../../core/Store.js";
import { getTenantKey } from "../middleware/auth.js";

export const createCoreRoutes = (store: ErixStore) => {
  const router = Router();

  router.post("/set", (req, res, next) => {
    try {
      const { key, value, ttl } = req.body;
      const tenantKey = getTenantKey(req.tenantId, key);

      // Lazy-expire then reserve. If the key is expired-but-not-yet-swept,
      // reserveKey deletes the stale value and clears the registry first,
      // so this SET can take over even if the prior type was different.
      store.reserveKey(tenantKey, "string");

      store.strings.set(tenantKey, value);
      if (ttl) {
        store.ttlManager.set(tenantKey, ttl);
      }
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/get", (req, res, next) => {
    try {
      const { key } = req.query;
      const tenantKey = getTenantKey(req.tenantId, key as string);

      if (store.isExpired(tenantKey)) {
        return res.json({ value: null });
      }

      // Reads must respect type — GET on a list returns WRONGTYPE, not null.
      store.types.assertType(tenantKey, "string");

      res.json({ value: store.strings.get(tenantKey) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/del", (req, res, next) => {
    try {
      const { key } = req.body;
      const tenantKey = getTenantKey(req.tenantId, key);

      // DEL is type-agnostic. The store routes the delete
      // to the owning sub-store and clears the type registry + TTL.
      const existed = store.deleteKey(tenantKey);
      res.json({ success: true, existed });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
