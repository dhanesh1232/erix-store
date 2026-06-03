/**
 * @file config-bgsave.test.ts
 *
 * Integration tests for CONFIG GET/SET and BGSAVE through `/tx/exec`.
 *
 * Coverage:
 *   1. CONFIG GET works for any authenticated tenant; pattern filtering works.
 *   2. CONFIG SET succeeds for the admin tenant and is reflected in subsequent
 *      CONFIG GET reads.
 *   3. CONFIG SET fails for non-admin tenants (per-command error result) and
 *      does NOT mutate the underlying value.
 *   4. CONFIG SET is denied entirely when no admin tenant is configured.
 *   5. BGSAVE invokes the registered callback exactly once and replies with
 *      Redis's "Background saving started" string.
 *   6. BGSAVE failures from the callback are logged but not surfaced to the
 *      client (matches Redis's fire-and-forget semantics).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import {
  ConfigRegistry,
  parseNonNegInt,
} from "../../src/services/ConfigRegistry.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";
import { SlowLog } from "../../src/services/SlowLog.js";
import { createTestValidator } from "../helpers/testValidator.js";

const ADMIN = "admin-tenant";
const REGULAR = "regular-tenant";
const API_KEY = "config-test-key";

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

interface Result<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
  code?: string;
}

describe("CONFIG GET/SET — admin gating", () => {
  let handler: ReturnType<typeof createRouteHandler>;
  let store: ErixStore;
  let rateLimiter: RateLimiterService;
  let slowlog: SlowLog;
  let config: ConfigRegistry;
  let originalApiKey: string | undefined;

  /** A sample tunable backed by a closure value — easy to inspect. */
  let backing = 42;

  const buildApp = (opts: {
    adminTenantId?: string;
    bgsave?: () => Promise<void> | void;
  }) => {
    backing = 42;
    config = new ConfigRegistry();
    config.register({
      name: "demo-int",
      get: () => String(backing),
      set: (raw) => {
        backing = parseNonNegInt(raw, "demo-int");
      },
    });

    store = new ErixStore();
    const pubsub = new PubSubService();
    rateLimiter = new RateLimiterService();
    slowlog = new SlowLog({ thresholdUs: 0 });

    const app = createApp(store, pubsub, rateLimiter, {
      slowlog,
      config,
      adminTenantId: opts.adminTenantId,
      bgsave: opts.bgsave,
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

  const exec = (
    tenant: string,
    commands: Array<{ name: string; args: unknown[] }>,
  ) =>
    callAs(handler, tenant, "POST", "/tx/exec", { commands }) as Promise<{
      status: number;
      data: { results: Result[] };
    }>;

  it("CONFIG GET works for any authenticated tenant", async () => {
    buildApp({ adminTenantId: ADMIN });

    const tx = await exec(REGULAR, [{ name: "CONFIG", args: ["GET", "*"] }]);
    expect(tx.status).toBe(200);
    const entries = tx.data.results[0].value as Array<{
      name: string;
      value: string;
    }>;
    expect(entries).toContainEqual({ name: "demo-int", value: "42" });
  });

  it("CONFIG GET filters by glob pattern", async () => {
    buildApp({ adminTenantId: ADMIN });
    config.register({
      name: "other-thing",
      get: () => "x",
      set: () => {},
    });

    const tx = await exec(REGULAR, [
      { name: "CONFIG", args: ["GET", "demo*"] },
    ]);
    const entries = tx.data.results[0].value as Array<{ name: string }>;
    expect(entries.map((e) => e.name)).toEqual(["demo-int"]);
  });

  it("CONFIG SET succeeds for the admin tenant", async () => {
    buildApp({ adminTenantId: ADMIN });

    const tx = await exec(ADMIN, [
      { name: "CONFIG", args: ["SET", "demo-int", "100"] },
    ]);
    expect(tx.data.results[0]).toEqual({ ok: true, value: "OK" });
    expect(backing).toBe(100);

    // Verify the new value reads back.
    const get = await exec(ADMIN, [
      { name: "CONFIG", args: ["GET", "demo-int"] },
    ]);
    const entries = get.data.results[0].value as Array<{ value: string }>;
    expect(entries[0].value).toBe("100");
  });

  it("CONFIG SET fails for non-admin tenants without mutating state", async () => {
    buildApp({ adminTenantId: ADMIN });

    const tx = await exec(REGULAR, [
      { name: "CONFIG", args: ["SET", "demo-int", "999"] },
    ]);
    expect(tx.data.results[0].ok).toBe(false);
    expect(tx.data.results[0].error).toMatch(/admin/i);
    expect(backing).toBe(42);
  });

  it("CONFIG SET is denied entirely when no admin tenant is configured", async () => {
    buildApp({}); // no adminTenantId

    const tx = await exec(ADMIN, [
      { name: "CONFIG", args: ["SET", "demo-int", "1"] },
    ]);
    expect(tx.data.results[0].ok).toBe(false);
    expect(tx.data.results[0].error).toMatch(/admin operations are disabled/i);
    expect(backing).toBe(42);
  });

  it("CONFIG SET propagates validator errors as per-command failures", async () => {
    buildApp({ adminTenantId: ADMIN });

    const tx = await exec(ADMIN, [
      { name: "CONFIG", args: ["SET", "demo-int", "not-a-number"] },
    ]);
    expect(tx.data.results[0].ok).toBe(false);
    expect(tx.data.results[0].error).toMatch(/non-negative integer/);
    expect(backing).toBe(42);
  });

  it("CONFIG SET against an unknown parameter returns an error", async () => {
    buildApp({ adminTenantId: ADMIN });

    const tx = await exec(ADMIN, [
      { name: "CONFIG", args: ["SET", "ghost", "x"] },
    ]);
    expect(tx.data.results[0].ok).toBe(false);
    expect(tx.data.results[0].error).toMatch(/unknown CONFIG parameter/);
  });
});

describe("BGSAVE", () => {
  let handler: ReturnType<typeof createRouteHandler>;
  let store: ErixStore;
  let rateLimiter: RateLimiterService;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ERIX_API_KEY;
    process.env.ERIX_API_KEY = API_KEY;
  });

  afterEach(() => {
    store?.ttlManager.stopSweep();
    rateLimiter?.destroy();
    process.env.ERIX_API_KEY = originalApiKey;
  });

  const buildApp = (opts: {
    adminTenantId?: string;
    bgsave?: () => Promise<void> | void;
  }) => {
    store = new ErixStore();
    const pubsub = new PubSubService();
    rateLimiter = new RateLimiterService();
    const config = new ConfigRegistry();
    const slowlog = new SlowLog({ thresholdUs: 0 });
    const app = createApp(store, pubsub, rateLimiter, {
      slowlog,
      config,
      adminTenantId: opts.adminTenantId,
      bgsave: opts.bgsave,
      authValidator: createTestValidator(API_KEY),
    });
    handler = createRouteHandler(app);
  };

  it("invokes the registered callback and returns 'Background saving started'", async () => {
    const cb = vi.fn().mockResolvedValue(undefined);
    buildApp({ adminTenantId: ADMIN, bgsave: cb });

    const tx = await callAs(handler, ADMIN, "POST", "/tx/exec", {
      commands: [{ name: "BGSAVE", args: [] }],
    });
    const result = (tx.data as { results: Result[] }).results[0];
    expect(result).toEqual({ ok: true, value: "Background saving started" });

    // The callback runs asynchronously — wait one microtask flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("denies BGSAVE for non-admin tenants without invoking the callback", async () => {
    const cb = vi.fn();
    buildApp({ adminTenantId: ADMIN, bgsave: cb });

    const tx = await callAs(handler, REGULAR, "POST", "/tx/exec", {
      commands: [{ name: "BGSAVE", args: [] }],
    });
    const result = (tx.data as { results: Result[] }).results[0];
    expect(result.ok).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it("returns an error when BGSAVE is not configured", async () => {
    buildApp({ adminTenantId: ADMIN }); // no bgsave callback

    const tx = await callAs(handler, ADMIN, "POST", "/tx/exec", {
      commands: [{ name: "BGSAVE", args: [] }],
    });
    const result = (tx.data as { results: Result[] }).results[0];
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });

  it("callback errors do not surface to the client (fire-and-forget)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cb = vi.fn().mockRejectedValue(new Error("disk full"));
    buildApp({ adminTenantId: ADMIN, bgsave: cb });

    const tx = await callAs(handler, ADMIN, "POST", "/tx/exec", {
      commands: [{ name: "BGSAVE", args: [] }],
    });
    expect((tx.data as { results: Result[] }).results[0].ok).toBe(true);

    // Let the rejected promise settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("BGSAVE failed: disk full"),
    );

    errSpy.mockRestore();
  });
});
