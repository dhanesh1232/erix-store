/**
 * @file slowlog.test.ts
 *
 * Integration tests for the SLOWLOG verb surface.
 *
 *   - SLOWLOG GET returns recorded entries (newest first), tenant-scoped.
 *   - SLOWLOG LEN counts only the calling tenant's entries.
 *   - SLOWLOG RESET drops only the calling tenant's entries.
 *   - SLOWLOG itself is never recorded (would otherwise feedback-loop).
 *   - When the slowlog is not wired in, SLOWLOG returns an error result.
 *
 * The threshold is set to 1 µs so every command records — that lets us
 * keep tests deterministic without needing fake clocks or sleeps.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";
import { SlowLog } from "../../src/services/SlowLog.js";
import { createTestValidator } from "../helpers/testValidator.js";

const TENANT = "tenant-slow";
const OTHER = "tenant-other";
const API_KEY = "slowlog-test-key";

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

describe("/tx/exec — SLOWLOG", () => {
  let handler: ReturnType<typeof createRouteHandler>;
  let store: ErixStore;
  let rateLimiter: RateLimiterService;
  let slowlog: SlowLog;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ERIX_API_KEY;
    process.env.ERIX_API_KEY = API_KEY;

    store = new ErixStore();
    const pubsub = new PubSubService();
    rateLimiter = new RateLimiterService();
    // Threshold of 1 µs makes every command land in the log.
    slowlog = new SlowLog({ thresholdUs: 1, maxLen: 16 });
    const app = createApp(store, pubsub, rateLimiter, {
      slowlog,
      authValidator: createTestValidator(API_KEY),
    });
    handler = createRouteHandler(app);
  });

  afterEach(() => {
    store.ttlManager.stopSweep();
    rateLimiter.destroy();
    process.env.ERIX_API_KEY = originalApiKey;
  });

  const exec = (
    tenantId: string,
    commands: Array<{ name: string; args: unknown[] }>,
  ) => callAs(handler, tenantId, "POST", "/tx/exec", { commands });

  it("records single commands and returns them via SLOWLOG GET", async () => {
    await exec(TENANT, [{ name: "SET", args: ["k", "v"] }]);
    await exec(TENANT, [{ name: "GET", args: ["k"] }]);

    const tx = await exec(TENANT, [{ name: "SLOWLOG", args: ["GET"] }]);
    const entries = (tx.data as { results: Array<{ value: unknown }> })
      .results[0].value as Array<{ command: string; source: string }>;

    // Newest first; SLOWLOG itself is not recorded.
    expect(entries.length).toBe(2);
    expect(entries[0].command).toBe("GET");
    expect(entries[1].command).toBe("SET");
    expect(entries[0].source).toBe("transaction");
  });

  it("SLOWLOG LEN matches what GET returns", async () => {
    await exec(TENANT, [
      { name: "SET", args: ["k", "v"] },
      { name: "GET", args: ["k"] },
      { name: "DEL", args: ["k"] },
    ]);

    const tx = await exec(TENANT, [{ name: "SLOWLOG", args: ["LEN"] }]);
    const len = (tx.data as { results: Array<{ value: number }> }).results[0]
      .value;
    expect(len).toBe(3);
  });

  it("SLOWLOG RESET drops this tenant's entries and reports the count", async () => {
    await exec(TENANT, [{ name: "SET", args: ["a", "1"] }]);
    await exec(TENANT, [{ name: "SET", args: ["b", "2"] }]);

    const reset = await exec(TENANT, [{ name: "SLOWLOG", args: ["RESET"] }]);
    const dropped = (reset.data as { results: Array<{ value: number }> })
      .results[0].value;
    expect(dropped).toBe(2);

    const after = await exec(TENANT, [{ name: "SLOWLOG", args: ["LEN"] }]);
    expect(
      (after.data as { results: Array<{ value: number }> }).results[0].value,
    ).toBe(0);
  });

  it("tenants only see their own slowlog entries", async () => {
    await exec(TENANT, [{ name: "SET", args: ["k", "v"] }]);
    await exec(OTHER, [{ name: "SET", args: ["k", "v"] }]);
    await exec(OTHER, [{ name: "SET", args: ["k2", "v"] }]);

    const mine = await exec(TENANT, [{ name: "SLOWLOG", args: ["LEN"] }]);
    const theirs = await exec(OTHER, [{ name: "SLOWLOG", args: ["LEN"] }]);
    expect(
      (mine.data as { results: Array<{ value: number }> }).results[0].value,
    ).toBe(1);
    expect(
      (theirs.data as { results: Array<{ value: number }> }).results[0].value,
    ).toBe(2);

    // RESET on TENANT must not affect OTHER.
    await exec(TENANT, [{ name: "SLOWLOG", args: ["RESET"] }]);
    const stillTheirs = await exec(OTHER, [{ name: "SLOWLOG", args: ["LEN"] }]);
    expect(
      (stillTheirs.data as { results: Array<{ value: number }> }).results[0]
        .value,
    ).toBe(2);
  });

  it("SLOWLOG itself is never recorded (no feedback loop)", async () => {
    await exec(TENANT, [{ name: "PING", args: [] }]);
    // Calling SLOWLOG GET many times must not balloon the log.
    for (let i = 0; i < 5; i++) {
      await exec(TENANT, [{ name: "SLOWLOG", args: ["GET"] }]);
    }
    const len = await exec(TENANT, [{ name: "SLOWLOG", args: ["LEN"] }]);
    expect(
      (len.data as { results: Array<{ value: number }> }).results[0].value,
    ).toBe(1);
  });

  it("SLOWLOG HELP returns the subcommand reference", async () => {
    const tx = await exec(TENANT, [{ name: "SLOWLOG", args: ["HELP"] }]);
    const help = (tx.data as { results: Array<{ value: string[] }> }).results[0]
      .value;
    expect(help.length).toBeGreaterThan(0);
    expect(help.join(" ")).toMatch(/SLOWLOG GET/);
  });

  it("argument truncation applies — long values are clipped", async () => {
    const huge = "x".repeat(500);
    await exec(TENANT, [{ name: "SET", args: ["k", huge] }]);
    const tx = await exec(TENANT, [{ name: "SLOWLOG", args: ["GET", 1] }]);
    const entries = (
      tx.data as { results: Array<{ value: Array<{ args: string[] }> }> }
    ).results[0].value;
    expect(entries[0].args[1].length).toBeLessThanOrEqual(128);
    expect(entries[0].args[1]).toMatch(/\.\.\.$/);
  });
});

describe("SLOWLOG when not wired in", () => {
  it("returns an error result without throwing", async () => {
    const originalApiKey = process.env.ERIX_API_KEY;
    process.env.ERIX_API_KEY = API_KEY;
    const store = new ErixStore();
    const pubsub = new PubSubService();
    const rateLimiter = new RateLimiterService();
    // Note: NO slowlog passed in.
    const app = createApp(store, pubsub, rateLimiter, {
      authValidator: createTestValidator(API_KEY),
    });
    const handler = createRouteHandler(app);

    const tx = await callAs(handler, TENANT, "POST", "/tx/exec", {
      commands: [{ name: "SLOWLOG", args: ["GET"] }],
    });
    const r = (tx.data as { results: Array<{ ok: boolean; error?: string }> })
      .results[0];
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/slowlog is not enabled/i);

    store.ttlManager.stopSweep();
    rateLimiter.destroy();
    process.env.ERIX_API_KEY = originalApiKey;
  });
});
