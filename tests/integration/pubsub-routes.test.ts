/**
 * @file pubsub-routes.test.ts
 *
 * Integration tests for the upgraded PubSub surface:
 *   - POST /pubsub/publish returns delivery count
 *   - GET  /pubsub/channels with optional glob (tenant-scoped)
 *   - POST /pubsub/numsub
 *   - GET  /pubsub/numpat
 *   - PUBLISH / PUBSUB CHANNELS / NUMSUB / NUMPAT through /tx/exec
 *
 * SSE streams (`/pubsub/:channel/stream` and `/pubsub/p/:pattern/stream`)
 * are not exercised here — they're long-lived connections best tested
 * directly against the service. The unit suite already proves delivery
 * semantics; these tests focus on the request/response wire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";
import { createTestValidator } from "../helpers/testValidator.js";

const TENANT = "tenant-ps";
const OTHER = "tenant-other";
const API_KEY = "pubsub-test-key";

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

describe("/pubsub/* — publish + introspection", () => {
  let handler: ReturnType<typeof createRouteHandler>;
  let store: ErixStore;
  let pubsub: PubSubService;
  let rateLimiter: RateLimiterService;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ERIX_API_KEY;
    process.env.ERIX_API_KEY = API_KEY;

    store = new ErixStore();
    pubsub = new PubSubService();
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

  it("PUBLISH returns the delivery count", async () => {
    // No subscribers yet
    const empty = await call("POST", "/pubsub/publish", {
      channel: "alerts",
      message: { id: 1 },
    });
    expect((empty.data as { delivered: number }).delivered).toBe(0);

    // Add an exact subscriber via the service directly (SSE bypasses the test).
    const cb = vi.fn();
    pubsub.subscribe(`${TENANT}:alerts`, cb);

    const one = await call("POST", "/pubsub/publish", {
      channel: "alerts",
      message: { id: 2 },
    });
    expect((one.data as { delivered: number }).delivered).toBe(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("CHANNELS lists tenant-scoped channels with the prefix stripped", async () => {
    pubsub.subscribe(`${TENANT}:alerts:high`, vi.fn());
    pubsub.subscribe(`${TENANT}:alerts:low`, vi.fn());
    pubsub.subscribe(`${OTHER}:alerts:foreign`, vi.fn());

    const all = await call("GET", "/pubsub/channels");
    const list = (all.data as { channels: string[] }).channels.sort();
    expect(list).toEqual(["alerts:high", "alerts:low"]);

    const filtered = await call("GET", "/pubsub/channels", undefined, {
      pattern: "alerts:h*",
    });
    expect((filtered.data as { channels: string[] }).channels).toEqual([
      "alerts:high",
    ]);
  });

  it("NUMSUB returns per-channel counts; missing channels report 0", async () => {
    pubsub.subscribe(`${TENANT}:a`, vi.fn());
    pubsub.subscribe(`${TENANT}:a`, vi.fn());
    pubsub.subscribe(`${TENANT}:b`, vi.fn());

    const res = await call("POST", "/pubsub/numsub", {
      channels: ["a", "b", "ghost"],
    });
    expect((res.data as { counts: Record<string, number> }).counts).toEqual({
      a: 2,
      b: 1,
      ghost: 0,
    });
  });

  it("NUMSUB rejects non-string channel arrays with 400", async () => {
    const bad = await call("POST", "/pubsub/numsub", { channels: [1, 2] });
    expect(bad.status).toBe(400);
  });

  it("NUMPAT counts distinct patterns server-wide", async () => {
    pubsub.psubscribe(`${TENANT}:p:*`, vi.fn());
    pubsub.psubscribe(`${TENANT}:p:*`, vi.fn()); // same pattern, dedupes
    pubsub.psubscribe(`${OTHER}:q:*`, vi.fn());

    const res = await call("GET", "/pubsub/numpat");
    expect((res.data as { count: number }).count).toBe(2);
  });

  it("PUBLISH rejects missing channel with 400", async () => {
    const bad = await call("POST", "/pubsub/publish", { message: "x" });
    expect(bad.status).toBe(400);
  });

  describe("PUBLISH / PUBSUB through /tx/exec", () => {
    it("PUBLISH delivers and returns count via the dispatcher", async () => {
      pubsub.subscribe(`${TENANT}:alerts`, vi.fn());
      pubsub.psubscribe(`${TENANT}:alerts*`, vi.fn());

      const tx = await call("POST", "/tx/exec", {
        commands: [{ name: "PUBLISH", args: ["alerts", "boom"] }],
      });
      const r = (tx.data as { results: Array<{ value: number }> }).results[0];
      expect(r.value).toBe(2);
    });

    it("PUBSUB CHANNELS + NUMSUB + NUMPAT all work in a transaction", async () => {
      pubsub.subscribe(`${TENANT}:a`, vi.fn());
      pubsub.subscribe(`${TENANT}:a`, vi.fn());
      pubsub.psubscribe(`${TENANT}:p:*`, vi.fn());

      const tx = await call("POST", "/tx/exec", {
        commands: [
          { name: "PUBSUB", args: ["CHANNELS"] },
          { name: "PUBSUB", args: ["NUMSUB", "a", "ghost"] },
          { name: "PUBSUB", args: ["NUMPAT"] },
        ],
      });
      const results = (tx.data as { results: Array<{ value: unknown }> })
        .results;

      expect(results[0].value).toEqual(["a"]);
      expect(results[1].value).toEqual({ a: 2, ghost: 0 });
      expect(results[2].value).toBe(1);
    });

    it("unknown PUBSUB subcommand surfaces as a per-command error", async () => {
      const tx = await call("POST", "/tx/exec", {
        commands: [{ name: "PUBSUB", args: ["FROBNICATE"] }],
      });
      const r = (tx.data as { results: Array<{ ok: boolean; error?: string }> })
        .results[0];
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/FROBNICATE/);
    });
  });
});
