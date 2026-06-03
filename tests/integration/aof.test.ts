/**
 * @file aof.test.ts
 *
 * End-to-end test of the AOF lifecycle:
 *   1. A first ErixStore writes a sequence of mutations through the
 *      dispatcher with AOF enabled.
 *   2. The store is torn down WITHOUT calling `persistence.save()` —
 *      simulating a crash where only the AOF survives.
 *   3. A second, fresh ErixStore replays the AOF and recovers exactly
 *      the same logical state.
 *
 * Also covers:
 *   - Mutating verbs are appended; reads (GET) and ephemeral verbs
 *     (PUBLISH, SLOWLOG, CONFIG) are not.
 *   - Failed mutations are not appended (so replay never fails).
 *   - BGREWRITEAOF compacts the log and the rewritten file replays
 *     to the same state.
 *   - BGREWRITEAOF is admin-gated.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import { dispatchCommand } from "../../src/server/commands.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import { AofLog } from "../../src/services/AofLog.js";
import { ConfigRegistry } from "../../src/services/ConfigRegistry.js";
import { PriorityQueue } from "../../src/services/PriorityQueue.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";
import { SlowLog } from "../../src/services/SlowLog.js";
import { createTestValidator } from "../helpers/testValidator.js";

const TENANT = "tenant-aof";
const ADMIN = "admin-tenant";
const REGULAR = "regular-tenant";
const API_KEY = "aof-test-key";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "erix-aof-int-"));
  path = join(dir, "aof.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Bundle {
  store: ErixStore;
  pubsub: PubSubService;
  rateLimiter: RateLimiterService;
  queue: PriorityQueue;
  slowlog: SlowLog;
  config: ConfigRegistry;
  aof: AofLog;
  handler: ReturnType<typeof createRouteHandler>;
  originalApiKey: string | undefined;
}

function buildBundle(opts: { adminTenantId?: string } = {}): Bundle {
  const originalApiKey = process.env.ERIX_API_KEY;
  process.env.ERIX_API_KEY = API_KEY;

  const store = new ErixStore();
  const pubsub = new PubSubService();
  const rateLimiter = new RateLimiterService();
  const queue = new PriorityQueue();
  const slowlog = new SlowLog({ thresholdUs: 0 });
  const config = new ConfigRegistry();
  const aof = new AofLog({ path, fsyncPolicy: "no" });

  const app = createApp(store, pubsub, rateLimiter, {
    queue,
    slowlog,
    config,
    aof,
    adminTenantId: opts.adminTenantId,
    authValidator: createTestValidator(API_KEY),
  });
  const handler = createRouteHandler(app);

  return {
    store,
    pubsub,
    rateLimiter,
    queue,
    slowlog,
    config,
    aof,
    handler,
    originalApiKey,
  };
}

function teardown(b: Bundle) {
  b.store.ttlManager.stopSweep();
  b.rateLimiter.destroy();
  b.aof.close();
  process.env.ERIX_API_KEY = b.originalApiKey;
}

async function callAs(
  handler: ReturnType<typeof createRouteHandler>,
  tenantId: string,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
) {
  return handler(method, path, body, { "x-tenant-id": tenantId, ...params });
}

interface Result {
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: string;
}

async function exec(
  handler: ReturnType<typeof createRouteHandler>,
  tenantId: string,
  commands: Array<{ name: string; args: unknown[] }>,
) {
  const res = await callAs(handler, tenantId, "POST", "/tx/exec", { commands });
  return (res.data as { results: Result[] }).results;
}

describe("AOF — append + replay round-trip", () => {
  it("recovers the live state from the AOF after a 'crash'", async () => {
    // Round 1: a fresh store with AOF enabled, writes a mix of types.
    const b1 = buildBundle();
    try {
      await exec(b1.handler, TENANT, [
        { name: "SET", args: ["s", "string-value"] },
        { name: "INCR", args: ["counter"] },
        { name: "INCR", args: ["counter"] },
        { name: "HSET", args: ["h", "f1", "v1", "f2", "v2"] },
        { name: "RPUSH", args: ["l", "a", "b", "c"] },
        { name: "SADD", args: ["set", "x", "y"] },
        { name: "ZADD", args: ["z", 1, "alpha", 2, "beta"] },
        { name: "ENQUEUE", args: ["q", "job-a", 5] },
        { name: "ENQUEUE", args: ["q", "job-b", 10] },
      ]);
    } finally {
      // No persistence.save() — only the AOF survives.
      teardown(b1);
    }

    // Round 2: brand-new bundle, replay the AOF.
    const b2 = buildBundle();
    try {
      const applied = b2.aof.replay((entry) => {
        const r = dispatchCommand(
          {
            store: b2.store,
            queue: b2.queue,
            pubsub: b2.pubsub,
            slowlog: b2.slowlog,
            config: b2.config,
            aof: b2.aof,
          },
          entry.tenantId,
          { name: entry.name, args: entry.args },
        );
        if (!r.ok) throw new Error(`replay failed: ${r.error}`);
      });
      expect(applied).toBeGreaterThan(0);

      // Verify each datatype came back intact.
      const out = await exec(b2.handler, TENANT, [
        { name: "GET", args: ["s"] },
        { name: "GET", args: ["counter"] },
        { name: "HGETALL", args: ["h"] },
        { name: "LRANGE", args: ["l", 0, -1] },
        { name: "SMEMBERS", args: ["set"] },
        { name: "ZRANGE", args: ["z", 0, -1] },
        // High-priority job should still come out first.
        { name: "DEQUEUE", args: ["q"] },
        { name: "DEQUEUE", args: ["q"] },
      ]);
      expect(out[0].value).toBe("string-value");
      expect(out[1].value).toBe("2");
      expect(out[2].value).toEqual({ f1: "v1", f2: "v2" });
      expect(out[3].value).toEqual(["a", "b", "c"]);
      expect((out[4].value as string[]).sort()).toEqual(["x", "y"]);
      expect(out[5].value).toEqual(["alpha", "beta"]);
      expect(out[6].value).toBe("job-b");
      expect(out[7].value).toBe("job-a");
    } finally {
      teardown(b2);
    }
  });

  it("does NOT append failed mutations (WRONGTYPE)", async () => {
    const b = buildBundle();
    try {
      await exec(b.handler, TENANT, [
        { name: "SET", args: ["k", "v"] },
        // This is WRONGTYPE; it must not land in the AOF.
        { name: "LPUSH", args: ["k", "x"] },
      ]);
    } finally {
      b.aof.close();
    }

    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { name: string });
    const verbs = lines.map((l) => l.name);
    expect(verbs).toEqual(["SET"]);

    teardown(b);
  });

  it("does NOT append reads or ephemeral verbs", async () => {
    const b = buildBundle();
    try {
      await exec(b.handler, TENANT, [
        { name: "SET", args: ["k", "v"] },
        { name: "GET", args: ["k"] }, // read
        { name: "EXISTS", args: ["k"] }, // read
        { name: "PING", args: [] }, // read
        { name: "SLOWLOG", args: ["GET"] }, // ephemeral
      ]);
    } finally {
      b.aof.close();
    }

    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { name: string });
    expect(lines.map((l) => l.name)).toEqual(["SET"]);

    teardown(b);
  });
});

describe("BGREWRITEAOF", () => {
  it("compacts the log and the rewritten file replays identically", async () => {
    const b1 = buildBundle({ adminTenantId: ADMIN });
    try {
      // Generate a noisy log with lots of redundant writes.
      for (let i = 0; i < 50; i++) {
        await exec(b1.handler, TENANT, [{ name: "INCR", args: ["counter"] }]);
      }
      await exec(b1.handler, TENANT, [
        { name: "SET", args: ["k", "final"] },
        { name: "RPUSH", args: ["l", "1", "2", "3"] },
      ]);
      const sizeBefore = b1.aof.sizeBytes;

      const rewriteResults = await exec(b1.handler, ADMIN, [
        { name: "BGREWRITEAOF", args: [] },
      ]);
      expect(rewriteResults[0].ok).toBe(true);
      expect(b1.aof.sizeBytes).toBeLessThan(sizeBefore);
    } finally {
      teardown(b1);
    }

    // Replay the rewritten file into a fresh bundle and verify state.
    const b2 = buildBundle({ adminTenantId: ADMIN });
    try {
      b2.aof.replay((entry) => {
        const r = dispatchCommand(
          {
            store: b2.store,
            queue: b2.queue,
            pubsub: b2.pubsub,
            slowlog: b2.slowlog,
            config: b2.config,
            aof: b2.aof,
          },
          entry.tenantId,
          { name: entry.name, args: entry.args },
        );
        if (!r.ok) throw new Error(`replay failed: ${r.error}`);
      });

      const out = await exec(b2.handler, TENANT, [
        { name: "GET", args: ["counter"] },
        { name: "GET", args: ["k"] },
        { name: "LRANGE", args: ["l", 0, -1] },
      ]);
      expect(out[0].value).toBe("50");
      expect(out[1].value).toBe("final");
      expect(out[2].value).toEqual(["1", "2", "3"]);
    } finally {
      teardown(b2);
    }
  });

  it("is admin-gated — non-admin tenants get an error", async () => {
    const b = buildBundle({ adminTenantId: ADMIN });
    try {
      const results = await exec(b.handler, REGULAR, [
        { name: "BGREWRITEAOF", args: [] },
      ]);
      expect(results[0].ok).toBe(false);
      expect(results[0].error).toMatch(/admin/i);
    } finally {
      teardown(b);
    }
  });

  it("returns an error when AOF is not enabled", async () => {
    // Build a bundle WITHOUT an AOF.
    const originalApiKey = process.env.ERIX_API_KEY;
    process.env.ERIX_API_KEY = API_KEY;
    const store = new ErixStore();
    const pubsub = new PubSubService();
    const rateLimiter = new RateLimiterService();
    const config = new ConfigRegistry();
    const slowlog = new SlowLog({ thresholdUs: 0 });
    const app = createApp(store, pubsub, rateLimiter, {
      slowlog,
      config,
      adminTenantId: ADMIN,
      authValidator: createTestValidator(API_KEY),
      // no aof
    });
    const handler = createRouteHandler(app);

    try {
      const tx = await callAs(handler, ADMIN, "POST", "/tx/exec", {
        commands: [{ name: "BGREWRITEAOF", args: [] }],
      });
      const r = (tx.data as { results: Result[] }).results[0];
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/AOF is not enabled/i);
    } finally {
      store.ttlManager.stopSweep();
      rateLimiter.destroy();
      process.env.ERIX_API_KEY = originalApiKey;
    }

    // Sanity: no AOF file should have been created.
    expect(existsSync(path)).toBe(false);
  });
});
