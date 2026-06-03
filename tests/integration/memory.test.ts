/**
 * @file memory.test.ts
 *
 * Integration tests for the memory cap end-to-end:
 *   - INFO exposes used_memory / maxmemory / policy / evicted_keys
 *   - OOM surfaces as HTTP 507 with code "OOM"
 *   - OOM surfaces as a per-command error inside /tx/exec
 *   - allkeys-lru evicts the LRU key under load (visible via DBSIZE)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";
import { createTestValidator } from "../helpers/testValidator.js";

const TENANT = "tenant-mem";
const API_KEY = "memory-test-key";

async function call(
  handler: ReturnType<typeof createRouteHandler>,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
) {
  return handler(method, path, body, { "x-tenant-id": TENANT, ...params });
}

describe("Memory cap (P2.1) end-to-end", () => {
  let handler: ReturnType<typeof createRouteHandler>;
  let store: ErixStore;
  let rateLimiter: RateLimiterService;
  let originalApiKey: string | undefined;

  const buildHandler = (memory: {
    maxBytes: number;
    policy: "noeviction" | "allkeys-lru" | "volatile-lru";
  }) => {
    store = new ErixStore({ memory });
    const pubsub = new PubSubService();
    rateLimiter = new RateLimiterService();
    const app = createApp(store, pubsub, rateLimiter, {
      authValidator: createTestValidator(API_KEY),
    });
    handler = createRouteHandler(app);
  };

  beforeEach(() => {
    originalApiKey = process.env.ERIX_API_KEY;
    process.env.ERIX_API_KEY = API_KEY;
  });

  afterEach(() => {
    store?.ttlManager.stopSweep();
    rateLimiter?.destroy();
    process.env.ERIX_API_KEY = originalApiKey;
  });

  it("INFO exposes used_memory + maxmemory + policy + evicted_keys", async () => {
    buildHandler({ maxBytes: 1_000_000, policy: "allkeys-lru" });

    await call(handler, "POST", "/core/set", { key: "k", value: "v" });

    const info = await call(handler, "GET", "/server/info");
    const data = info.data as {
      memory: {
        used_memory: number;
        maxmemory: number;
        maxmemory_policy: string;
        evicted_keys: number;
      };
    };
    expect(data.memory.maxmemory).toBe(1_000_000);
    expect(data.memory.maxmemory_policy).toBe("allkeys-lru");
    expect(data.memory.used_memory).toBeGreaterThan(0);
    expect(data.memory.evicted_keys).toBe(0);
  });

  it("OOM surfaces as HTTP 507 with code 'OOM' under noeviction", async () => {
    buildHandler({ maxBytes: 1_000_000, policy: "noeviction" });

    // Seed a key, then tighten the cap so the next write must OOM.
    await call(handler, "POST", "/core/set", { key: "seed", value: "x" });
    store.accountant.setMaxBytes(store.accountant.usedBytes + 1);

    const res = await call(handler, "POST", "/core/set", {
      key: "overflow",
      value: "this will not fit",
    });

    expect(res.status).toBe(507);
    expect((res.data as { code: string }).code).toBe("OOM");
  });

  it("allkeys-lru evicts the LRU key automatically", async () => {
    buildHandler({ maxBytes: 1_000_000, policy: "allkeys-lru" });

    await call(handler, "POST", "/core/set", { key: "first", value: "1" });
    await call(handler, "POST", "/core/set", { key: "second", value: "2" });

    // Tighten the cap so any further write must evict.
    store.accountant.setMaxBytes(store.accountant.usedBytes + 1);
    await call(handler, "POST", "/core/set", { key: "third", value: "3" });

    // 'first' is gone; 'third' is present; evicted_keys >= 1.
    const get1 = await call(handler, "GET", "/core/get", undefined, {
      key: "first",
    });
    expect((get1.data as { value: unknown }).value).toBe(null);

    const get3 = await call(handler, "GET", "/core/get", undefined, {
      key: "third",
    });
    expect((get3.data as { value: string }).value).toBe("3");

    const info = await call(handler, "GET", "/server/info");
    const evicted = (info.data as { memory: { evicted_keys: number } }).memory
      .evicted_keys;
    expect(evicted).toBeGreaterThanOrEqual(1);
  });

  it("OOM inside /tx/exec is captured as a per-command error", async () => {
    buildHandler({ maxBytes: 1_000_000, policy: "noeviction" });
    await call(handler, "POST", "/core/set", { key: "seed", value: "x" });
    store.accountant.setMaxBytes(store.accountant.usedBytes + 1);

    const tx = await call(handler, "POST", "/tx/exec", {
      commands: [
        { name: "SET", args: ["a", "ok"] }, // first SET will hit OOM
        { name: "GET", args: ["seed"] }, // subsequent commands must still run
      ],
    });
    const results = (
      tx.data as {
        results: Array<{ ok: boolean; code?: string; value?: unknown }>;
      }
    ).results;
    expect(results[0].ok).toBe(false);
    expect(results[0].code).toBe("OOM");
    expect(results[1]).toEqual({ ok: true, value: "x" });
  });
});
