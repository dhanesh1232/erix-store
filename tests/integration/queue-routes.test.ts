/**
 * @file queue-routes.test.ts
 *
 * Integration tests for `/q/*` — the Redis-style priority queue routes.
 *
 * Two things this file is responsible for proving:
 *
 *   1. The verbs work end-to-end via the Express app: ENQUEUE, DEQUEUE,
 *      QLEN, QPEEK, QCLEAR. This is the Phase-4 checklist coverage.
 *   2. Tenant isolation: tenant A's dequeue never sees tenant B's entries.
 *      This guards against a regression where the route forgets to apply
 *      `getTenantKey` and namespaces collapse into a shared global queue.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import { PriorityQueue } from "../../src/services/PriorityQueue.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";
import { createTestValidator } from "../helpers/testValidator.js";

const TENANT = "tenant-q";
const OTHER = "tenant-other";
const API_KEY = "queue-routes-key";

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

describe("/q/* (Redis-style priority queue routes)", () => {
  let handler: ReturnType<typeof createRouteHandler>;
  let store: ErixStore;
  let rateLimiter: RateLimiterService;
  let queue: PriorityQueue;
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

  const call = (
    method: string,
    path: string,
    body?: unknown,
    params: Record<string, string> = {},
  ) => callAs(handler, TENANT, method, path, body, params);

  it("ENQUEUE returns the new length and DEQUEUE recovers the value", async () => {
    const enq = await call("POST", "/q/enqueue", {
      name: "jobs",
      value: JSON.stringify({ id: 1 }),
      priority: 0,
    });
    expect(enq.status).toBe(200);
    expect((enq.data as { length: number }).length).toBe(1);

    const deq = await call("POST", "/q/dequeue", { name: "jobs" });
    expect(deq.status).toBe(200);
    const value = (deq.data as { value: string }).value;
    expect(value).toBeDefined();
    expect(JSON.parse(value!)).toEqual({ id: 1 });
  });

  it("higher priority dequeues first; ties resolve FIFO", async () => {
    await call("POST", "/q/enqueue", {
      name: "jobs",
      value: "low-first",
      priority: 1,
    });
    await call("POST", "/q/enqueue", {
      name: "jobs",
      value: "high",
      priority: 10,
    });
    await call("POST", "/q/enqueue", {
      name: "jobs",
      value: "low-second",
      priority: 1,
    });

    const a = await call("POST", "/q/dequeue", { name: "jobs" });
    const b = await call("POST", "/q/dequeue", { name: "jobs" });
    const c = await call("POST", "/q/dequeue", { name: "jobs" });

    expect((a.data as { value: string }).value).toBe("high");
    expect((b.data as { value: string }).value).toBe("low-first");
    expect((c.data as { value: string }).value).toBe("low-second");
  });

  it("QLEN reports current length; QPEEK does not consume", async () => {
    await call("POST", "/q/enqueue", { name: "q", value: "a", priority: 5 });
    await call("POST", "/q/enqueue", { name: "q", value: "b", priority: 1 });

    const len = await call("GET", "/q/len", undefined, { name: "q" });
    expect((len.data as { length: number }).length).toBe(2);

    const peek1 = await call("GET", "/q/peek", undefined, { name: "q" });
    const peek2 = await call("GET", "/q/peek", undefined, { name: "q" });
    expect((peek1.data as { value: string }).value).toBe("a");
    expect((peek2.data as { value: string }).value).toBe("a");

    // Length must be unchanged.
    const lenAfter = await call("GET", "/q/len", undefined, { name: "q" });
    expect((lenAfter.data as { length: number }).length).toBe(2);
  });

  it("QCLEAR drops every entry and returns the count", async () => {
    await call("POST", "/q/enqueue", { name: "q", value: "a" });
    await call("POST", "/q/enqueue", { name: "q", value: "b" });
    await call("POST", "/q/enqueue", { name: "q", value: "c" });

    const clear = await call("POST", "/q/clear", { name: "q" });
    expect((clear.data as { cleared: number }).cleared).toBe(3);

    const len = await call("GET", "/q/len", undefined, { name: "q" });
    expect((len.data as { length: number }).length).toBe(0);

    const deq = await call("POST", "/q/dequeue", { name: "q" });
    expect((deq.data as { value: unknown }).value).toBe(null);
  });

  it("DEQUEUE on an empty queue returns { value: null }", async () => {
    const res = await call("POST", "/q/dequeue", { name: "ghost" });
    expect(res.status).toBe(200);
    expect((res.data as { value: unknown }).value).toBe(null);
  });

  it("rejects requests missing `name` with 400", async () => {
    const enq = await call("POST", "/q/enqueue", { value: "x" });
    expect(enq.status).toBe(400);

    const deq = await call("POST", "/q/dequeue", {});
    expect(deq.status).toBe(400);

    const len = await call("GET", "/q/len");
    expect(len.status).toBe(400);

    const peek = await call("GET", "/q/peek");
    expect(peek.status).toBe(400);

    const clear = await call("POST", "/q/clear", {});
    expect(clear.status).toBe(400);
  });

  it("rejects non-string value with 400", async () => {
    const enq = await call("POST", "/q/enqueue", {
      name: "q",
      value: { not: "a string" },
    });
    expect(enq.status).toBe(400);
  });

  it("isolates tenants — tenant B's dequeue cannot see tenant A's entries", async () => {
    // Tenant A enqueues 3 jobs.
    await callAs(handler, TENANT, "POST", "/q/enqueue", {
      name: "jobs",
      value: "a1",
    });
    await callAs(handler, TENANT, "POST", "/q/enqueue", {
      name: "jobs",
      value: "a2",
    });
    await callAs(handler, TENANT, "POST", "/q/enqueue", {
      name: "jobs",
      value: "a3",
    });

    // Tenant B's view of the same queue name is empty.
    const lenB = await callAs(handler, OTHER, "GET", "/q/len", undefined, {
      name: "jobs",
    });
    expect((lenB.data as { length: number }).length).toBe(0);

    const deqB = await callAs(handler, OTHER, "POST", "/q/dequeue", {
      name: "jobs",
    });
    expect((deqB.data as { value: unknown }).value).toBe(null);

    // Tenant A's queue is untouched.
    const lenA = await callAs(handler, TENANT, "GET", "/q/len", undefined, {
      name: "jobs",
    });
    expect((lenA.data as { length: number }).length).toBe(3);
  });
});
