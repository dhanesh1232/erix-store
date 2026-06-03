/**
 * @file server.routes.ts
 * @module Server/Routes/Server
 *
 * ErixStore server commands — the equivalents of `PING`, `INFO`,
 * `DBSIZE`, `EXISTS`, `TYPE`, `KEYS`, `FLUSHDB`, `EXPIRE`, `TTL`, `PERSIST`.
 *
 * All commands respect tenant isolation: every key the client supplies is
 * prefixed with `${tenantId}:` before lookup, and `KEYS` / `DBSIZE` / `FLUSHDB`
 * only see keys inside the calling tenant's namespace. There is no way for
 * one tenant to read or wipe another's data via this route.
 *
 * Mounted at `/server` from `app.ts`.
 *
 * @requirements P0.4 — server commands
 */

import { Router } from "express";
import type { ErixStore } from "../../core/Store.js";
import { globToRegExp } from "../glob.js";
import { getTenantKey } from "../middleware/auth.js";

/**
 * Build a per-tenant matcher for KEYS:
 *   - Prepends `${tenantId}:` to the user's pattern so foreign keys cannot leak.
 *   - Returns a function that strips the tenant prefix from matching keys
 *     before returning them to the client.
 */
function tenantMatcher(tenantId: string, pattern: string) {
  const prefix = `${tenantId}:`;
  const fullPattern = `${prefix}${pattern}`;
  const re = globToRegExp(fullPattern);
  return {
    test: (fullKey: string) => fullKey.startsWith(prefix) && re.test(fullKey),
    strip: (fullKey: string) => fullKey.slice(prefix.length),
  };
}

export const createServerRoutes = (store: ErixStore) => {
  const router = Router();

  // ── PING ───────────────────────────────────────────────────────────────

  router.get("/ping", (_req, res) => {
    res.json({ pong: true });
  });

  // ── INFO ───────────────────────────────────────────────────────────────
  // Process-wide metrics. Tenant-scoped where it would otherwise leak data.

  router.get("/info", (req, res) => {
    const mem = process.memoryUsage();

    // Tenant-scoped key counts
    const prefix = `${req.tenantId}:`;
    const tenantKeys = { string: 0, hash: 0, list: 0, set: 0, zset: 0 };
    for (const k of store.types.keys()) {
      if (!k.startsWith(prefix)) continue;
      const t = store.types.getType(k);
      if (t) tenantKeys[t]++;
    }

    res.json({
      server: {
        version: process.env.npm_package_version ?? "1.1.0",
        node: process.version,
        uptime_seconds: process.uptime(),
      },
      memory: {
        rss: mem.rss,
        heap_used: mem.heapUsed,
        heap_total: mem.heapTotal,
        external: mem.external,
        // Approximate accounting from MemoryAccountant. Not the same
        // as `rss`/`heap_used` — those are V8 process metrics; these
        // are the values used by the maxmemory cap. See byteCost.ts.
        used_memory: store.accountant.usedBytes,
        maxmemory: store.accountant.maxBytes,
        maxmemory_policy: store.accountant.policy,
        evicted_keys: store.accountant.evictedKeys,
      },
      keyspace: {
        // Total across all tenants — useful for operators
        total_keys: store.types.size,
        // Per-tenant breakdown for the calling tenant
        tenant: { id: req.tenantId, keys: tenantKeys },
      },
    });
  });

  // ── DBSIZE ─────────────────────────────────────────────────────────────
  // Number of keys in the calling tenant's namespace.

  router.get("/dbsize", (req, res) => {
    const prefix = `${req.tenantId}:`;
    let n = 0;
    for (const k of store.types.keys()) {
      if (k.startsWith(prefix)) n++;
    }
    res.json({ size: n });
  });

  // ── EXISTS ─────────────────────────────────────────────────────────────

  router.get("/exists", (req, res) => {
    const { key } = req.query;
    const tenantKey = getTenantKey(req.tenantId, key as string);
    // Lazy expiry on read so an expired key reports as missing.
    if (store.isExpired(tenantKey)) {
      return res.json({ exists: false });
    }
    res.json({ exists: store.types.getType(tenantKey) !== null });
  });

  // ── TYPE ───────────────────────────────────────────────────────────────

  router.get("/type", (req, res) => {
    const { key } = req.query;
    const tenantKey = getTenantKey(req.tenantId, key as string);
    if (store.isExpired(tenantKey)) {
      return res.json({ type: null });
    }
    res.json({ type: store.types.getType(tenantKey) });
  });

  // ── KEYS pattern ───────────────────────────────────────────────────────

  router.get("/keys", (req, res) => {
    const pattern = (req.query.pattern as string) ?? "*";
    const matcher = tenantMatcher(req.tenantId, pattern);
    const out: string[] = [];
    for (const k of store.types.keys()) {
      if (!matcher.test(k)) continue;
      // Skip lazily-expired keys so KEYS can't surface ghosts.
      if (store.isExpired(k)) continue;
      out.push(matcher.strip(k));
    }
    res.json({ keys: out });
  });

  // ── FLUSHDB ────────────────────────────────────────────────────────────
  // Tenant-scoped only. There is intentionally no FLUSHALL.

  router.post("/flushdb", (req, res) => {
    const count = store.flushTenant(req.tenantId);
    res.json({ success: true, flushed: count });
  });

  // ── EXPIRE / TTL / PERSIST ─────────────────────────────────────────────

  router.post("/expire", (req, res) => {
    const { key, ttl } = req.body;
    const seconds = Number(ttl);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return res.status(400).json({ error: "ttl must be a positive integer" });
    }
    const tenantKey = getTenantKey(req.tenantId, key);
    if (store.isExpired(tenantKey) || store.types.getType(tenantKey) === null) {
      // Returns 0 (= false) when the key does not exist
      return res.json({ applied: false });
    }
    store.ttlManager.set(tenantKey, seconds);
    res.json({ applied: true });
  });

  router.get("/ttl", (req, res) => {
    const { key } = req.query;
    const tenantKey = getTenantKey(req.tenantId, key as string);
    // TTL convention:
    //   -2 → key does not exist
    //   -1 → key exists but has no TTL
    //   >0 → seconds remaining
    if (store.isExpired(tenantKey) || store.types.getType(tenantKey) === null) {
      return res.json({ ttl: -2 });
    }
    const remaining = store.ttlManager.getTTL(tenantKey);
    res.json({ ttl: remaining }); // -1 if no TTL
  });

  router.post("/persist", (req, res) => {
    const { key } = req.body;
    const tenantKey = getTenantKey(req.tenantId, key);
    if (store.isExpired(tenantKey) || store.types.getType(tenantKey) === null) {
      return res.json({ removed: false });
    }
    res.json({ removed: store.ttlManager.persist(tenantKey) });
  });

  return router;
};
