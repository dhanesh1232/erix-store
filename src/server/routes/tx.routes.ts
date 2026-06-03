/**
 * @file tx.routes.ts
 * @module Server/Routes/Tx
 *
 * Transactions: MULTI / EXEC.
 *
 * Wire protocol
 * -------------
 *   POST /tx/exec
 *   {
 *     "commands": [
 *       { "name": "SET",   "args": ["key", "value"] },
 *       { "name": "EXPIRE","args": ["key", 60] },
 *       { "name": "GET",   "args": ["key"] }
 *     ]
 *   }
 *
 *   → 200
 *   {
 *     "results": [
 *       { "ok": true, "value": "OK" },
 *       { "ok": true, "value": 1 },
 *       { "ok": true, "value": "value" }
 *     ]
 *   }
 *
 * Atomicity
 * ---------
 * The whole batch runs inside a single event-loop tick via
 * {@link dispatchTransaction}. Other clients cannot interleave requests
 * between the commands. Per-command errors are captured but do not abort
 * the batch — matching MULTI/EXEC semantics.
 *
 * DISCARD is a purely client-side operation: the SDK simply drops the
 * queued commands and never sends a request. There is no server route.
 *
 * @requirements P1.2 — MULTI/EXEC/DISCARD
 */

import { Router } from "express";
import type { ErixStore } from "../../core/Store.js";
import type { AofLog } from "../../services/AofLog.js";
import type { ConfigRegistry } from "../../services/ConfigRegistry.js";
import type { PriorityQueue } from "../../services/PriorityQueue.js";
import type { PubSubService } from "../../services/PubSub.js";
import type { SlowLog } from "../../services/SlowLog.js";
import {
  type Command,
  type DispatcherDeps,
  dispatchTransaction,
} from "../commands.js";

const MAX_COMMANDS = 1000;

function isCommandShape(c: unknown): c is Command {
  if (typeof c !== "object" || c === null) return false;
  const obj = c as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    obj.name.length > 0 &&
    Array.isArray(obj.args)
  );
}

export interface TxRouteDeps {
  store: ErixStore;
  queue?: PriorityQueue;
  pubsub?: PubSubService;
  slowlog?: SlowLog;
  config?: ConfigRegistry;
  adminTenantId?: string;
  bgsave?: () => Promise<void> | void;
  aof?: AofLog;
}

export const createTxRoutes = (deps: TxRouteDeps) => {
  const router = Router();
  const dispatcherDeps: DispatcherDeps = deps;

  router.post("/exec", (req, res, next) => {
    try {
      const { commands } = req.body ?? {};
      if (!Array.isArray(commands)) {
        return res
          .status(400)
          .json({ error: "`commands` must be an array of { name, args }" });
      }
      // Empty array is valid — MULTI; EXEC; → empty array.
      if (commands.length > MAX_COMMANDS) {
        return res
          .status(400)
          .json({ error: `transaction exceeds ${MAX_COMMANDS} commands` });
      }

      const invalid = commands.findIndex((c) => !isCommandShape(c));
      if (invalid !== -1) {
        return res.status(400).json({
          error: `command at index ${invalid} is malformed (need { name: string, args: unknown[] })`,
        });
      }

      // The dispatcher is synchronous — control does not yield until
      // every command has run.
      const results = dispatchTransaction(
        dispatcherDeps,
        req.tenantId,
        commands as Command[],
      );
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
