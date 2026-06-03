/**
 * @file queue.routes.ts
 * @module Server/Routes/Queue
 *
 * Priority queue verbs — `ENQUEUE`, `DEQUEUE`, `QLEN`,
 * `QPEEK`, `QCLEAR`. Backed by {@link PriorityQueue}, kept distinct
 * from `/queue/v2/*` (the WAL-backed workflow engine).
 *
 * Mounted at `/q` to avoid colliding with `/queue/v2` (Express prefix
 * routing would otherwise force a careful ordering). The client SDK
 * still exposes these as `client.queue.enqueue(…)` etc.
 *
 * @requirements P1.1 — ENQUEUE/DEQUEUE/QLEN/QPEEK/QCLEAR
 */

import { Router } from "express";
import type { PriorityQueue } from "../../services/PriorityQueue.js";
import { getTenantKey } from "../middleware/auth.js";

export const createQueueRoutes = (queue: PriorityQueue) => {
  const router = Router();

  /**
   * ENQUEUE
   * POST /q/enqueue { name, value, priority? }
   * Returns the new length so callers can size-check without a follow-up.
   */
  router.post("/enqueue", (req, res, next) => {
    try {
      const { name, value, priority } = req.body ?? {};
      if (typeof name !== "string" || !name) {
        return res.status(400).json({ error: "name is required" });
      }
      if (typeof value !== "string") {
        return res
          .status(400)
          .json({ error: "value must be a string (already JSON-serialized)" });
      }
      const p = priority === undefined ? 0 : Number(priority);
      if (!Number.isFinite(p)) {
        return res.status(400).json({ error: "priority must be a number" });
      }
      const tenantQueue = getTenantKey(req.tenantId, name);
      const length = queue.enqueue(tenantQueue, value, p);
      res.json({ success: true, length });
    } catch (err) {
      next(err);
    }
  });

  /**
   * DEQUEUE
   * POST /q/dequeue { name }
   * Pops the highest-priority entry. Returns `{ value: null }` when empty.
   * Uses POST (not GET) because it mutates state.
   */
  router.post("/dequeue", (req, res, next) => {
    try {
      const { name } = req.body ?? {};
      if (typeof name !== "string" || !name) {
        return res.status(400).json({ error: "name is required" });
      }
      const tenantQueue = getTenantKey(req.tenantId, name);
      const value = queue.dequeue(tenantQueue);
      res.json({ value });
    } catch (err) {
      next(err);
    }
  });

  /**
   * QLEN
   * GET /q/len?name=foo
   */
  router.get("/len", (req, res, next) => {
    try {
      const name = req.query.name as string | undefined;
      if (!name) return res.status(400).json({ error: "name is required" });
      const tenantQueue = getTenantKey(req.tenantId, name);
      res.json({ length: queue.len(tenantQueue) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * QPEEK
   * GET /q/peek?name=foo
   */
  router.get("/peek", (req, res, next) => {
    try {
      const name = req.query.name as string | undefined;
      if (!name) return res.status(400).json({ error: "name is required" });
      const tenantQueue = getTenantKey(req.tenantId, name);
      res.json({ value: queue.peek(tenantQueue) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * QCLEAR
   * POST /q/clear { name }
   * Returns the number of entries discarded.
   */
  router.post("/clear", (req, res, next) => {
    try {
      const { name } = req.body ?? {};
      if (typeof name !== "string" || !name) {
        return res.status(400).json({ error: "name is required" });
      }
      const tenantQueue = getTenantKey(req.tenantId, name);
      res.json({ success: true, cleared: queue.clear(tenantQueue) });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
