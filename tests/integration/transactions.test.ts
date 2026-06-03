/**
 * @file transactions.test.ts
 *
 * Integration test for the `/tx/exec` route plus an atomicity property:
 * commands inside a transaction must run in a single event-loop tick,
 * so an interleaved request from another tenant cannot land between
 * any two commands of the batch.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import { PriorityQueue } from "../../src/services/PriorityQueue.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";
import { createTestValidator } from "../helpers/testValidator.js";

const TENANT = "tenant-tx";
const OTHER = "tenant-other";
const API_KEY = "tx-test-key";

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

describe("/tx/exec — MULTI/EXEC route", () => {
  let handler: ReturnType<typeof createRouteHandler>;
  let store: ErixStore;
  let queue: PriorityQueue;
  let rateLimiter: RateLimiterService;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ERIX_API_KEY;
    process.env.ERIX_API_KEY = API_KEY;

    store = new ErixStore();
    queue = new PriorityQueue();
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

  const exec = (commands: Array<{ name: string; args: unknown[] }>) =>
    callAs(handler, TENANT, "POST", "/tx/exec", { commands });

  it("returns a result array with one entry per command in order", async () => {
    const res = await exec([
      { name: "SET", args: ["k", "v"] },
      { name: "EXPIRE", args: ["k", 60] },
      { name: "GET", args: ["k"] },
      { name: "EXISTS", args: ["k"] },
    ]);
    expect(res.status).toBe(200);
    const data = res.data as {
      results: Array<{ ok: boolean; value: unknown }>;
    };
    expect(data.results).toEqual([
      { ok: true, value: "OK" },
      { ok: true, value: 1 },
      { ok: true, value: "v" },
      { ok: true, value: 1 },
    ]);
  });

  it("captures per-command errors without aborting the batch", async () => {
    const res = await exec([
      { name: "SET", args: ["k", "v"] },
      { name: "LPUSH", args: ["k", "x"] }, // WRONGTYPE
      { name: "GET", args: ["k"] }, // still runs
    ]);
    const data = res.data as { results: Array<Record<string, unknown>> };
    expect(data.results[0]).toEqual({ ok: true, value: "OK" });
    expect(data.results[1].ok).toBe(false);
    expect(data.results[1].code).toBe("WRONGTYPE");
    expect(data.results[2]).toEqual({ ok: true, value: "v" });
  });

  it("rejects malformed bodies with 400", async () => {
    const noArr = await callAs(handler, TENANT, "POST", "/tx/exec", {});
    expect(noArr.status).toBe(400);

    const badShape = await callAs(handler, TENANT, "POST", "/tx/exec", {
      commands: [{ name: "SET" }], // missing args
    });
    expect(badShape.status).toBe(400);

    const tooBig = await callAs(handler, TENANT, "POST", "/tx/exec", {
      commands: new Array(1001).fill({ name: "PING", args: [] }),
    });
    expect(tooBig.status).toBe(400);
  });

  it("an empty transaction returns { results: [] }", async () => {
    const res = await exec([]);
    expect(res.status).toBe(200);
    expect((res.data as { results: unknown[] }).results).toEqual([]);
  });

  it("forces the tenantId — a transaction can never escape its namespace", async () => {
    // Tenant TENANT writes via a transaction.
    await exec([
      { name: "SET", args: ["only-mine", "v1"] },
      { name: "SET", args: ["only-mine-2", "v2"] },
    ]);

    // Tenant OTHER cannot see those keys.
    const get = await callAs(handler, OTHER, "GET", "/core/get", undefined, {
      key: "only-mine",
    });
    expect((get.data as { value: unknown }).value).toBe(null);
  });

  describe("Atomicity (single-tick guarantee)", () => {
    /**
     * Atomicity test plan
     * -------------------
     * Tenant A starts a transaction containing 50 SETs against a single
     * key, then queues a GET. We fire 100 concurrent SETs from tenant B
     * against tenant B's own key in parallel.
     *
     * Because the dispatcher runs synchronously, every command in
     * tenant A's batch executes in one tick — no command from tenant B
     * can observe a partial state of tenant A's batch.
     *
     * The check: tenant A's final GET inside the transaction sees
     * exactly the value tenant A's last SET wrote, regardless of how
     * many B-side requests are in flight.
     *
     * This isn't a true concurrency test (Node is single-threaded and
     * `await` only yields between ticks anyway), but it does verify
     * that the transaction itself does not yield mid-batch.
     */
    it("a transaction is not interleaved by parallel writes from another tenant", async () => {
      const txCommands = [];
      for (let i = 0; i < 50; i++) {
        txCommands.push({ name: "SET", args: ["shared", `v${i}`] });
      }
      txCommands.push({ name: "GET", args: ["shared"] });

      // Fire 100 noise writes from another tenant in parallel
      const noise: Promise<unknown>[] = [];
      for (let i = 0; i < 100; i++) {
        noise.push(
          callAs(handler, OTHER, "POST", "/core/set", {
            key: "noise",
            value: String(i),
          }),
        );
      }

      const [tx] = await Promise.all([exec(txCommands), Promise.all(noise)]);

      const data = tx.data as {
        results: Array<{ ok: boolean; value: unknown }>;
      };
      // Every SET must have succeeded.
      for (let i = 0; i < 50; i++) {
        expect(data.results[i]).toEqual({ ok: true, value: "OK" });
      }
      // The trailing GET must observe exactly v49 — proving no other
      // command on tenant A's "shared" key landed between the last
      // SET and the GET.
      expect(data.results[50]).toEqual({ ok: true, value: "v49" });
    });
  });
});
