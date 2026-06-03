/**
 * @file ttl-passive.test.ts
 *
 * Integration test: every read route checks `store.isExpired` before
 * touching the underlying data. Routes covered:
 *   GET /core/get
 *   GET /hash/hget, /hash/hgetall
 *   GET /list/lpop, /list/rpop, /list/llen, /list/lindex, /list/lrange
 *   GET /set/smembers, /set/zrange
 *
 * We set a TTL, advance system time past it, stop the active sweep so
 * we exercise the *passive* path, then assert each route returns the
 * empty/null variant rather than the stale value.
 *
 * Also verifies that a logically-expired key can be overwritten as a
 * *different* type without WRONGTYPE — the reserveKey contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";
import { createTestValidator } from "../helpers/testValidator.js";

const TENANT = "tenant-ttl";
const API_KEY = "ttl-test-key";

async function call(
  handler: ReturnType<typeof createRouteHandler>,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
) {
  return handler(method, path, body, { "x-tenant-id": TENANT, ...params });
}

describe("Passive TTL expiry across all read routes", () => {
  let handler: ReturnType<typeof createRouteHandler>;
  let store: ErixStore;
  let originalApiKey: string | undefined;
  let rateLimiter: RateLimiterService;

  beforeEach(() => {
    vi.useFakeTimers();
    originalApiKey = process.env.ERIX_API_KEY;
    process.env.ERIX_API_KEY = API_KEY;

    store = new ErixStore();
    // Disable the active sweep so we can isolate passive-path behavior.
    store.ttlManager.stopSweep();

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
    vi.useRealTimers();
  });

  const expire = (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
  };

  it("string GET returns null for an expired key", async () => {
    await call(handler, "POST", "/core/set", {
      key: "s",
      value: "v",
      ttl: 1,
    });
    expire(1500);
    const res = await call(handler, "GET", "/core/get", undefined, {
      key: "s",
    });
    expect((res.data as { value: unknown }).value).toBe(null);
  });

  it("hash HGET / HGETALL return null for an expired key", async () => {
    await call(handler, "POST", "/hash/hset", {
      key: "h",
      field: "f",
      value: "v",
    });
    store.ttlManager.set(`${TENANT}:h`, 1);

    expire(1500);

    const hget = await call(handler, "GET", "/hash/hget", undefined, {
      key: "h",
      field: "f",
    });
    expect((hget.data as { value: unknown }).value).toBe(null);

    const hgetall = await call(handler, "GET", "/hash/hgetall", undefined, {
      key: "h",
    });
    expect((hgetall.data as { data: unknown }).data).toBe(null);
  });

  it("list reads return empty/null for an expired key", async () => {
    await call(handler, "POST", "/list/rpush", { key: "l", value: "x" });
    store.ttlManager.set(`${TENANT}:l`, 1);

    expire(1500);

    const lpop = await call(handler, "GET", "/list/lpop", undefined, {
      key: "l",
    });
    expect((lpop.data as { value: unknown }).value).toBe(null);

    const rpop = await call(handler, "GET", "/list/rpop", undefined, {
      key: "l",
    });
    expect((rpop.data as { value: unknown }).value).toBe(null);

    const llen = await call(handler, "GET", "/list/llen", undefined, {
      key: "l",
    });
    expect((llen.data as { length: number }).length).toBe(0);

    const lindex = await call(handler, "GET", "/list/lindex", undefined, {
      key: "l",
      index: "0",
    });
    expect((lindex.data as { value: unknown }).value).toBe(null);

    const lrange = await call(handler, "GET", "/list/lrange", undefined, {
      key: "l",
      start: "0",
      stop: "-1",
    });
    expect((lrange.data as { values: unknown[] }).values).toEqual([]);
  });

  it("set SMEMBERS / sorted set ZRANGE return empty for an expired key", async () => {
    await call(handler, "POST", "/set/sadd", { key: "s", value: "a" });
    store.ttlManager.set(`${TENANT}:s`, 1);

    await call(handler, "POST", "/set/zadd", {
      key: "z",
      score: 1,
      value: "a",
    });
    store.ttlManager.set(`${TENANT}:z`, 1);

    expire(1500);

    const smembers = await call(handler, "GET", "/set/smembers", undefined, {
      key: "s",
    });
    expect((smembers.data as { members: unknown[] }).members).toEqual([]);

    const zrange = await call(handler, "GET", "/set/zrange", undefined, {
      key: "z",
      start: "0",
      stop: "-1",
    });
    expect((zrange.data as { members: unknown[] }).members).toEqual([]);
  });

  it("an expired-but-not-swept key can be overwritten as a different type", async () => {
    await call(handler, "POST", "/core/set", {
      key: "k",
      value: "old",
      ttl: 1,
    });
    expire(1500);

    // Without reserveKey, this would fail with WRONGTYPE because the
    // type registry still says "string".
    const lpush = await call(handler, "POST", "/list/lpush", {
      key: "k",
      value: "fresh",
    });
    expect(lpush.status).toBe(200);

    const lpop = await call(handler, "GET", "/list/lpop", undefined, {
      key: "k",
    });
    expect((lpop.data as { value: string }).value).toBe("fresh");
  });
});
