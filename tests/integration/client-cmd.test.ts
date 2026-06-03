/**
 * @file client-cmd.test.ts
 *
 * Integration test for the `client.cmd()` shortcut and a few of the new
 * SDK-named methods that depend on it. The dispatcher itself is covered
 * exhaustively in the unit suite — this file just confirms the verb
 * results survive the round-trip through `/tx/exec`.
 *
 * Every assertion runs the request through the WebSocket bridge handler,
 * which is the same code path real clients use over WS.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import { PriorityQueue } from "../../src/services/PriorityQueue.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";
import { createTestValidator } from "../helpers/testValidator.js";

const TENANT = "tenant-cmd";
const API_KEY = "client-cmd-key";

async function call(
  handler: ReturnType<typeof createRouteHandler>,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
) {
  return handler(method, path, body, { "x-tenant-id": TENANT, ...params });
}

describe("/tx/exec one-command shortcut (client.cmd)", () => {
  let handler: ReturnType<typeof createRouteHandler>;
  let store: ErixStore;
  let rateLimiter: RateLimiterService;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ERIX_API_KEY;
    process.env.ERIX_API_KEY = API_KEY;

    store = new ErixStore();
    const queue = new PriorityQueue();
    const pubsub = new PubSubService();
    rateLimiter = new RateLimiterService();
    const app = createApp(store, pubsub, rateLimiter, {
      queue,
      authValidator: createTestValidator(API_KEY),
    });
    handler = createRouteHandler(app);
  });

  afterEach(() => {
    store.ttlManager.stopSweep();
    rateLimiter.destroy();
    process.env.ERIX_API_KEY = originalApiKey;
  });

  /** Run a single command via /tx/exec, mirroring what client.cmd() does. */
  const cmd = async (name: string, ...args: unknown[]) => {
    const res = await call(handler, "POST", "/tx/exec", {
      commands: [{ name, args }],
    });
    expect(res.status).toBe(200);
    return (
      res.data as {
        results: Array<
          | { ok: true; value: unknown }
          | { ok: false; error: string; code?: string }
        >;
      }
    ).results[0];
  };

  it("INCR / APPEND / STRLEN survive the round-trip", async () => {
    expect(await cmd("INCR", "counter")).toEqual({ ok: true, value: 1 });
    expect(await cmd("INCR", "counter")).toEqual({ ok: true, value: 2 });
    expect(await cmd("APPEND", "log", "hello")).toEqual({ ok: true, value: 5 });
    expect(await cmd("APPEND", "log", " world")).toEqual({
      ok: true,
      value: 11,
    });
    expect(await cmd("STRLEN", "log")).toEqual({ ok: true, value: 11 });
  });

  it("MSET / MGET behave identically to the dispatcher path", async () => {
    expect(await cmd("MSET", "a", "1", "b", "2", "c", "3")).toEqual({
      ok: true,
      value: "OK",
    });
    expect(await cmd("MGET", "a", "missing", "c")).toEqual({
      ok: true,
      value: ["1", null, "3"],
    });
  });

  it("HMSET / HMGET / HKEYS / HVALS / HLEN", async () => {
    expect(await cmd("HMSET", "h", "a", "1", "b", "2")).toEqual({
      ok: true,
      value: "OK",
    });
    expect(await cmd("HMGET", "h", "a", "b", "missing")).toEqual({
      ok: true,
      value: ["1", "2", null],
    });
    expect(await cmd("HLEN", "h")).toEqual({ ok: true, value: 2 });

    const keys = await cmd("HKEYS", "h");
    expect(keys.ok).toBe(true);
    expect((keys as { value: string[] }).value.sort()).toEqual(["a", "b"]);
  });

  it("set algebra: SADD / SCARD / SINTER / SUNION / SDIFF", async () => {
    await cmd("SADD", "a", "1", "2", "3");
    await cmd("SADD", "b", "2", "3", "4");
    expect(await cmd("SCARD", "a")).toEqual({ ok: true, value: 3 });

    const inter = await cmd("SINTER", "a", "b");
    expect((inter as { value: string[] }).value.sort()).toEqual(["2", "3"]);

    const uni = await cmd("SUNION", "a", "b");
    expect((uni as { value: string[] }).value.sort()).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);

    const diff = await cmd("SDIFF", "a", "b");
    expect((diff as { value: string[] }).value.sort()).toEqual(["1"]);
  });

  it("zset surface: ZRANK / ZREVRANGE / ZCOUNT / ZINCRBY / ZRANGEBYSCORE", async () => {
    await cmd("ZADD", "z", 1, "a", 2, "b", 3, "c");
    expect(await cmd("ZRANK", "z", "b")).toEqual({ ok: true, value: 1 });
    expect(await cmd("ZREVRANGE", "z", 0, -1)).toEqual({
      ok: true,
      value: ["c", "b", "a"],
    });
    expect(await cmd("ZCOUNT", "z", 2, 3)).toEqual({ ok: true, value: 2 });
    expect(await cmd("ZINCRBY", "z", 10, "a")).toEqual({ ok: true, value: 11 });
    expect(await cmd("ZRANGEBYSCORE", "z", 2, 5)).toEqual({
      ok: true,
      value: ["b", "c"],
    });
  });

  it("captures unknown verbs and per-command errors without HTTP failure", async () => {
    const r = await cmd("HCF");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("UNKNOWN_COMMAND");
  });
});
