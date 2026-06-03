/**
 * @file wrongtype.test.ts
 *
 * End-to-end test of the WRONGTYPE guarantee at the HTTP layer.
 *
 * Spins up a real Express app with all data routes wired in, then
 * verifies that operations on a key holding a different type are
 * rejected with HTTP 409 + Redis-style WRONGTYPE message — without
 * mutating the underlying store.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";
import { createTestValidator } from "../helpers/testValidator.js";

const TENANT = "tenant-a";
const API_KEY = "wrongtype-test-key";

interface Result {
  status: number;
  data: unknown;
}

async function call(
  handler: ReturnType<typeof createRouteHandler>,
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string>,
): Promise<Result> {
  return handler(method, path, body, {
    // inject auth via the WS bridge's params channel
    "x-tenant-id": TENANT,
    ...params,
  });
}

describe("WRONGTYPE enforcement (integration)", () => {
  let handler: ReturnType<typeof createRouteHandler>;
  let store: ErixStore;
  let originalApiKey: string | undefined;
  let rateLimiter: RateLimiterService;

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

  it("rejects LPUSH on an existing string key with 409 WRONGTYPE", async () => {
    const setRes = await call(handler, "POST", "/core/set", {
      key: "k1",
      value: "hello",
    });
    expect(setRes.status).toBe(200);

    const lpushRes = await call(handler, "POST", "/list/lpush", {
      key: "k1",
      value: "world",
    });
    expect(lpushRes.status).toBe(409);
    expect((lpushRes.data as { error: string; code: string }).code).toBe(
      "WRONGTYPE",
    );
    expect((lpushRes.data as { error: string }).error).toContain("WRONGTYPE");

    // String value must still be intact
    const getRes = await call(handler, "GET", "/core/get", undefined, {
      key: "k1",
    });
    expect((getRes.data as { value: string }).value).toBe("hello");
  });

  it("rejects HSET on an existing list key with 409 WRONGTYPE", async () => {
    await call(handler, "POST", "/list/lpush", { key: "k2", value: "a" });
    const hsetRes = await call(handler, "POST", "/hash/hset", {
      key: "k2",
      field: "f",
      value: "v",
    });
    expect(hsetRes.status).toBe(409);
  });

  it("rejects GET on an existing hash key with 409 WRONGTYPE", async () => {
    await call(handler, "POST", "/hash/hset", {
      key: "k3",
      field: "f",
      value: "v",
    });
    const getRes = await call(handler, "GET", "/core/get", undefined, {
      key: "k3",
    });
    expect(getRes.status).toBe(409);
  });

  it("allows the key to be reused after DEL", async () => {
    await call(handler, "POST", "/core/set", { key: "k4", value: "old" });
    await call(handler, "DELETE", "/core/del", { key: "k4" });

    const lpushRes = await call(handler, "POST", "/list/lpush", {
      key: "k4",
      value: "fresh",
    });
    expect(lpushRes.status).toBe(200);
  });

  it("allows the key to be reused after the list drains via LPOP", async () => {
    await call(handler, "POST", "/list/lpush", { key: "k5", value: "only" });
    const popRes = await call(handler, "GET", "/list/lpop", undefined, {
      key: "k5",
    });
    expect((popRes.data as { value: string }).value).toBe("only");

    const setRes = await call(handler, "POST", "/core/set", {
      key: "k5",
      value: "now-a-string",
    });
    expect(setRes.status).toBe(200);
  });

  it("does not mutate the existing value on a rejected operation", async () => {
    await call(handler, "POST", "/core/set", { key: "k6", value: "intact" });

    // Try several wrong-type operations
    await call(handler, "POST", "/list/rpush", { key: "k6", value: "x" });
    await call(handler, "POST", "/hash/hset", {
      key: "k6",
      field: "f",
      value: "v",
    });
    await call(handler, "POST", "/set/sadd", { key: "k6", value: "x" });
    await call(handler, "POST", "/set/zadd", {
      key: "k6",
      score: 1,
      value: "x",
    });

    const getRes = await call(handler, "GET", "/core/get", undefined, {
      key: "k6",
    });
    expect((getRes.data as { value: string }).value).toBe("intact");
  });
});
