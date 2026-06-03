/**
 * @file keyValidator.test.ts
 *
 * Unit tests for the per-org KeyValidator (Batch 1).
 *
 * Six unit cases covering the two lanes (internal `eint_…` / external
 * `erix_…`) and the in-memory cache:
 *
 *   1. Internal key valid — `eint_…` key in the internal list with any
 *      tenantId returns `kind: "internal"` and echoes the tenantId.
 *   2. External key valid — `erix_…` key matching a row in
 *      `ecodrix_organizations` with matching `client_code` and
 *      `status === "active"` returns `kind: "external"` plus orgId.
 *   3. External wrong tenantId — DB row found but `client_code`
 *      mismatch → 403 TENANT_MISMATCH.
 *   4. External suspended org — DB row found, code matches, but
 *      `status !== "active"` → 403 ORG_SUSPENDED.
 *   5. Unknown prefix — neither `eint_` nor `erix_` → 401
 *      UNKNOWN_KEY_PREFIX.
 *   6. Cache hit — back-to-back validate() calls with the same args
 *      produce only one DB round-trip.
 *
 * The pool is mocked: the validator only reaches for `pool.query(sql,
 * params)` and consumes `{ rows: OrgRow[] }`, so a single `vi.fn()` is
 * enough — no real Postgres needed.
 */

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { KeyValidator } from "../../src/server/middleware/keyValidator.js";

// ─── Mock Pool ───────────────────────────────────────────────────────────────

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function createMockPool(): MockPool {
  return { query: vi.fn() };
}

function asPgPool(mock: MockPool): Pool {
  return mock as unknown as Pool;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const INTERNAL_KEY = "eint_test_internal_abcdef";
const EXTERNAL_KEY = "erix_test_external_abcdef";
const CLIENT_CODE = "ACME-CORP";
const ORG_ID = "00000000-0000-0000-0000-000000000001";

function makeValidator(
  pool: MockPool,
  overrides: { now?: () => number; cacheTtlMs?: number } = {},
): KeyValidator {
  return new KeyValidator({
    pool: asPgPool(pool),
    internalKeys: [INTERNAL_KEY],
    ...overrides,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("KeyValidator", () => {
  it("accepts an internal eint_ key with any supplied tenantId", async () => {
    const pool = createMockPool();
    const validator = makeValidator(pool);

    const result = await validator.validate(INTERNAL_KEY, "literally-anything");

    expect(result).toEqual({
      ok: true,
      kind: "internal",
      tenantId: "literally-anything",
    });
    // Internal lane never touches the DB.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("accepts an external erix_ key when the org row matches and is active", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: ORG_ID, client_code: CLIENT_CODE, status: "active" }],
    });
    const validator = makeValidator(pool);

    const result = await validator.validate(EXTERNAL_KEY, CLIENT_CODE);

    expect(result).toEqual({
      ok: true,
      kind: "external",
      tenantId: CLIENT_CODE,
      orgId: ORG_ID,
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
    // Sanity-check the query was parameterised with the apiKey, not
    // concatenated into the SQL string.
    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual([EXTERNAL_KEY]);
  });

  it("rejects an external key when the supplied tenantId differs from client_code (403 TENANT_MISMATCH)", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: ORG_ID, client_code: CLIENT_CODE, status: "active" }],
    });
    const validator = makeValidator(pool);

    const result = await validator.validate(EXTERNAL_KEY, "WRONG-TENANT");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.code).toBe("TENANT_MISMATCH");
  });

  it("rejects an external key whose org is suspended (403 ORG_SUSPENDED)", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: ORG_ID, client_code: CLIENT_CODE, status: "suspended" }],
    });
    const validator = makeValidator(pool);

    const result = await validator.validate(EXTERNAL_KEY, CLIENT_CODE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.code).toBe("ORG_SUSPENDED");
  });

  it("rejects keys with an unknown prefix (401 UNKNOWN_KEY_PREFIX)", async () => {
    const pool = createMockPool();
    const validator = makeValidator(pool);

    const result = await validator.validate("bogus_key_no_prefix", CLIENT_CODE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.code).toBe("UNKNOWN_KEY_PREFIX");
    // Unknown-prefix keys are rejected before any DB lookup.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("caches successful external lookups so a second validate() does not re-query the DB (within TTL)", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: ORG_ID, client_code: CLIENT_CODE, status: "active" }],
    });
    // Inject a controllable clock so we can assert TTL behavior
    // without relying on real wall-clock time. The second call
    // happens 30 s after the first — well inside the 60 s default.
    let nowMs = 1_000_000;
    const validator = makeValidator(pool, { now: () => nowMs });

    const first = await validator.validate(EXTERNAL_KEY, CLIENT_CODE);
    nowMs += 30_000; // advance halfway into the TTL window
    const second = await validator.validate(EXTERNAL_KEY, CLIENT_CODE);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
