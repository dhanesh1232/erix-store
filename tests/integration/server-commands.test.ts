/**
 * @file server-commands.test.ts
 *
 * Integration tests for the `/server/*` route family — PING, INFO,
 * DBSIZE, EXISTS, TYPE, KEYS, FLUSHDB, EXPIRE, TTL, PERSIST.
 *
 * Every assertion here is a direct translation of one Phase-4 verification
 * checklist item, just executed via the SDK route layer instead of redis-cli.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";
import { createTestValidator } from "../helpers/testValidator.js";

const TENANT = "tenant-srv";
const OTHER_TENANT = "tenant-other";
const API_KEY = "server-cmd-key";

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

describe("/server/* commands", () => {
  let handler: ReturnType<typeof createRouteHandler>;
  let store: ErixStore;
  let rateLimiter: RateLimiterService;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ERIX_API_KEY;
    process.env.ERIX_API_KEY = API_KEY;

    store = new ErixStore();
    const pubsub = new PubSubService();
    rateLimiter = new RateLimiterService();
    const app = createApp(store, pubsub, rateLimiter, {
      authValidator: createTestValidator(API_KEY),
    });
    handler = createRouteHandler(app);
  });

  afterEach(() => {
    store.ttlManager.stopSweep();
    rateLimiter.destroy();
    process.env.ERIX_API_KEY = originalApiKey;
  });

  const call = (
    method: string,
    path: string,
    body?: unknown,
    params: Record<string, string> = {},
  ) => callAs(handler, TENANT, method, path, body, params);

  it("PING → { pong: true }", async () => {
    const res = await call("GET", "/server/ping");
    expect(res.status).toBe(200);
    expect((res.data as { pong: boolean }).pong).toBe(true);
  });

  it("INFO returns server, memory, and per-tenant keyspace blocks", async () => {
    await call("POST", "/core/set", { key: "k", value: "v" });
    await call("POST", "/list/rpush", { key: "l", value: "v" });

    const res = await call("GET", "/server/info");
    expect(res.status).toBe(200);
    const data = res.data as {
      server: { uptime_seconds: number };
      memory: { rss: number };
      keyspace: {
        total_keys: number;
        tenant: { id: string; keys: Record<string, number> };
      };
    };
    expect(data.server.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(data.memory.rss).toBeGreaterThan(0);
    expect(data.keyspace.tenant.id).toBe(TENANT);
    expect(data.keyspace.tenant.keys.string).toBe(1);
    expect(data.keyspace.tenant.keys.list).toBe(1);
  });

  it("DBSIZE counts only this tenant's keys", async () => {
    await call("POST", "/core/set", { key: "k1", value: "v" });
    await call("POST", "/core/set", { key: "k2", value: "v" });
    await callAs(handler, OTHER_TENANT, "POST", "/core/set", {
      key: "k3",
      value: "v",
    });

    const mine = await call("GET", "/server/dbsize");
    expect((mine.data as { size: number }).size).toBe(2);

    const theirs = await callAs(handler, OTHER_TENANT, "GET", "/server/dbsize");
    expect((theirs.data as { size: number }).size).toBe(1);
  });

  it("EXISTS returns true for live keys, false for missing or expired", async () => {
    await call("POST", "/core/set", { key: "alive", value: "v" });
    const yes = await call("GET", "/server/exists", undefined, {
      key: "alive",
    });
    expect((yes.data as { exists: boolean }).exists).toBe(true);

    const no = await call("GET", "/server/exists", undefined, { key: "ghost" });
    expect((no.data as { exists: boolean }).exists).toBe(false);
  });

  it("TYPE reports the correct type for each data structure", async () => {
    await call("POST", "/core/set", { key: "s", value: "v" });
    await call("POST", "/hash/hset", { key: "h", field: "f", value: "v" });
    await call("POST", "/list/rpush", { key: "l", value: "v" });
    await call("POST", "/set/sadd", { key: "set", value: "v" });
    await call("POST", "/set/zadd", { key: "z", score: 1, value: "v" });

    const types = await Promise.all([
      call("GET", "/server/type", undefined, { key: "s" }),
      call("GET", "/server/type", undefined, { key: "h" }),
      call("GET", "/server/type", undefined, { key: "l" }),
      call("GET", "/server/type", undefined, { key: "set" }),
      call("GET", "/server/type", undefined, { key: "z" }),
      call("GET", "/server/type", undefined, { key: "missing" }),
    ]);

    expect((types[0].data as { type: string }).type).toBe("string");
    expect((types[1].data as { type: string }).type).toBe("hash");
    expect((types[2].data as { type: string }).type).toBe("list");
    expect((types[3].data as { type: string }).type).toBe("set");
    expect((types[4].data as { type: string }).type).toBe("zset");
    expect((types[5].data as { type: string | null }).type).toBe(null);
  });

  it("KEYS returns matching keys with the tenant prefix stripped", async () => {
    await call("POST", "/core/set", { key: "user:1", value: "a" });
    await call("POST", "/core/set", { key: "user:2", value: "b" });
    await call("POST", "/core/set", { key: "session:9", value: "c" });
    // A foreign tenant's matching key must NOT appear.
    await callAs(handler, OTHER_TENANT, "POST", "/core/set", {
      key: "user:3",
      value: "x",
    });

    const all = await call("GET", "/server/keys", undefined, { pattern: "*" });
    const keysAll = (all.data as { keys: string[] }).keys.sort();
    expect(keysAll).toEqual(["session:9", "user:1", "user:2"]);

    const users = await call("GET", "/server/keys", undefined, {
      pattern: "user:*",
    });
    expect((users.data as { keys: string[] }).keys.sort()).toEqual([
      "user:1",
      "user:2",
    ]);
  });

  it("KEYS escapes regex metacharacters so a.b doesn't match axb", async () => {
    await call("POST", "/core/set", { key: "a.b", value: "v" });
    await call("POST", "/core/set", { key: "axb", value: "v" });

    const res = await call("GET", "/server/keys", undefined, {
      pattern: "a.b",
    });
    expect((res.data as { keys: string[] }).keys).toEqual(["a.b"]);
  });

  it("FLUSHDB wipes only the calling tenant", async () => {
    await call("POST", "/core/set", { key: "mine", value: "v" });
    await callAs(handler, OTHER_TENANT, "POST", "/core/set", {
      key: "theirs",
      value: "v",
    });

    const flushed = await call("POST", "/server/flushdb");
    expect((flushed.data as { flushed: number }).flushed).toBe(1);

    const mySize = await call("GET", "/server/dbsize");
    expect((mySize.data as { size: number }).size).toBe(0);

    const theirSize = await callAs(
      handler,
      OTHER_TENANT,
      "GET",
      "/server/dbsize",
    );
    expect((theirSize.data as { size: number }).size).toBe(1);
  });

  describe("EXPIRE / TTL / PERSIST", () => {
    it("EXPIRE attaches a TTL to a live key", async () => {
      await call("POST", "/core/set", { key: "k", value: "v" });
      const ok = await call("POST", "/server/expire", { key: "k", ttl: 60 });
      expect((ok.data as { applied: boolean }).applied).toBe(true);

      const ttl = await call("GET", "/server/ttl", undefined, { key: "k" });
      expect((ttl.data as { ttl: number }).ttl).toBeGreaterThan(0);
      expect((ttl.data as { ttl: number }).ttl).toBeLessThanOrEqual(60);
    });

    it("EXPIRE returns applied=false for a missing key", async () => {
      const res = await call("POST", "/server/expire", {
        key: "ghost",
        ttl: 60,
      });
      expect((res.data as { applied: boolean }).applied).toBe(false);
    });

    it("EXPIRE rejects non-positive TTL with 400", async () => {
      await call("POST", "/core/set", { key: "k", value: "v" });
      const zero = await call("POST", "/server/expire", { key: "k", ttl: 0 });
      expect(zero.status).toBe(400);
      const negative = await call("POST", "/server/expire", {
        key: "k",
        ttl: -1,
      });
      expect(negative.status).toBe(400);
    });

    it("TTL returns -2 for missing, -1 for no TTL, >0 for live TTL", async () => {
      const missing = await call("GET", "/server/ttl", undefined, {
        key: "ghost",
      });
      expect((missing.data as { ttl: number }).ttl).toBe(-2);

      await call("POST", "/core/set", { key: "no-ttl", value: "v" });
      const noTtl = await call("GET", "/server/ttl", undefined, {
        key: "no-ttl",
      });
      expect((noTtl.data as { ttl: number }).ttl).toBe(-1);

      await call("POST", "/core/set", { key: "with-ttl", value: "v", ttl: 30 });
      const withTtl = await call("GET", "/server/ttl", undefined, {
        key: "with-ttl",
      });
      expect((withTtl.data as { ttl: number }).ttl).toBeGreaterThan(0);
    });

    it("PERSIST removes a TTL and reports it; missing/no-TTL keys return false", async () => {
      await call("POST", "/core/set", { key: "k", value: "v", ttl: 30 });
      const removed = await call("POST", "/server/persist", { key: "k" });
      expect((removed.data as { removed: boolean }).removed).toBe(true);

      const after = await call("GET", "/server/ttl", undefined, { key: "k" });
      expect((after.data as { ttl: number }).ttl).toBe(-1);

      const noTtl = await call("POST", "/server/persist", { key: "k" });
      expect((noTtl.data as { removed: boolean }).removed).toBe(false);

      const ghost = await call("POST", "/server/persist", { key: "ghost" });
      expect((ghost.data as { removed: boolean }).removed).toBe(false);
    });
  });

  it("EXISTS / TYPE return false / null after a key expires (passive)", async () => {
    vi.useFakeTimers();
    try {
      await call("POST", "/core/set", { key: "tmp", value: "v", ttl: 1 });
      vi.setSystemTime(Date.now() + 1500);

      const exists = await call("GET", "/server/exists", undefined, {
        key: "tmp",
      });
      expect((exists.data as { exists: boolean }).exists).toBe(false);

      const type = await call("GET", "/server/type", undefined, { key: "tmp" });
      expect((type.data as { type: string | null }).type).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });
});
