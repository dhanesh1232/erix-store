/**
 * @file keyValidator.ts
 * @module Server/Middleware/KeyValidator
 *
 * Per-org API key validator for erix-store.
 *
 * Replaces the legacy single-shared-secret check (`ERIX_API_KEY`) with a
 * two-lane validator that distinguishes internal callers (your own
 * server/worker fleet) from external customers signing in with a key
 * minted in their `ecodrix_organizations` row.
 *
 * Key prefixes
 * ------------
 *   - `eint_` — Internal. Compared timing-safely against the
 *     comma-separated list in `ERIX_INTERNAL_KEY`. Internal callers may
 *     impersonate any tenant by setting `x-tenant-id` to whatever they
 *     need (audited upstream by the calling service).
 *   - `erix_` — External. Looked up in `ecodrix_organizations.api_key`.
 *     The supplied tenant identifier MUST equal the row's
 *     `client_code`, and the org's `status` MUST be `active`.
 *
 * Caching
 * -------
 * Successful lookups are cached for 60 s keyed on `apiKey|clientCode`.
 * Failed lookups are NOT cached, so rotations and typos recover on the
 * next attempt.
 *
 * This file only exposes the validator class + helpers — wiring into
 * the request pipeline lives in `auth.ts` (next task).
 */

import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

// ─── Constants ────────────────────────────────────────────────────────────────

export const INTERNAL_KEY_PREFIX = "eint_";
export const EXTERNAL_KEY_PREFIX = "erix_";

/** Default lifetime of a cached positive validation. */
export const DEFAULT_CACHE_TTL_MS = 60_000;

// ─── Result types ─────────────────────────────────────────────────────────────

/** Successful internal-key validation. tenantId is whatever the caller asked for. */
export interface InternalKeyContext {
  readonly ok: true;
  readonly kind: "internal";
  readonly tenantId: string;
}

/** Successful external-key validation. tenantId equals the org's clientCode. */
export interface ExternalKeyContext {
  readonly ok: true;
  readonly kind: "external";
  readonly tenantId: string;
  readonly orgId: string;
}

export type ValidatedContext = InternalKeyContext | ExternalKeyContext;

/** Machine-readable failure codes. The HTTP status maps 1:1 in `auth.ts`. */
export type KeyValidationFailureCode =
  | "MISSING_KEY"
  | "MISSING_TENANT"
  | "UNKNOWN_KEY_PREFIX"
  | "INVALID_INTERNAL_KEY"
  | "INVALID_EXTERNAL_KEY"
  | "TENANT_MISMATCH"
  | "ORG_SUSPENDED"
  | "DB_ERROR";

export interface KeyValidationFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: KeyValidationFailureCode;
  readonly message: string;
}

export type KeyValidationResult = ValidatedContext | KeyValidationFailure;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse `ERIX_INTERNAL_KEY` (comma-separated list of internal keys).
 * Empty / whitespace-only entries are dropped silently.
 */
export function parseInternalKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Constant-time comparison of `candidate` against any entry in `known`.
 * Length-mismatched entries are skipped without exposing their lengths
 * — `timingSafeEqual` throws on length mismatch, so we filter first.
 *
 * NOTE: this leaks `candidate.length` (since we only call timingSafeEqual
 * on equal-length entries). Internal keys are operator-controlled and
 * rotated rarely, so this is an acceptable trade-off for code clarity.
 */
function constantTimeAnyEqual(
  candidate: Buffer,
  known: readonly Buffer[],
): boolean {
  let matched = false;
  for (const entry of known) {
    if (entry.length !== candidate.length) continue;
    // `|=` rather than early-return so every same-length entry is
    // compared in full, removing per-position branching.
    if (timingSafeEqual(candidate, entry)) {
      matched = true;
    }
  }
  return matched;
}

// ─── Validator ────────────────────────────────────────────────────────────────

interface OrgRow {
  id: string;
  client_code: string;
  status: string | null;
}

interface CacheEntry {
  context: ValidatedContext;
  expiresAt: number;
}

export interface KeyValidatorOptions {
  /** Connection pool used for the `ecodrix_organizations` lookup. */
  pool: Pool;
  /** Internal `eint_…` keys. Typically parsed from `ERIX_INTERNAL_KEY`. */
  internalKeys?: readonly string[];
  /** Cache lifetime in milliseconds. Defaults to {@link DEFAULT_CACHE_TTL_MS}. */
  cacheTtlMs?: number;
  /** Clock injection point for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Validates an `(apiKey, clientCode)` pair and resolves the tenant
 * context the caller is allowed to operate in.
 *
 * Stateless aside from the in-memory positive-result cache; safe to
 * share across the whole Express app.
 */
export class KeyValidator {
  private readonly pool: Pool;
  private readonly internalKeys: readonly Buffer[];
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: KeyValidatorOptions) {
    this.pool = options.pool;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.internalKeys = (options.internalKeys ?? [])
      .filter((entry) => entry.length > 0)
      .map((entry) => Buffer.from(entry));
  }

  /**
   * Resolve and cache the tenant context for a request.
   *
   * Returns a discriminated union — callers pattern-match on `result.ok`
   * and, when truthy, on `result.kind` to differentiate internal vs.
   * external lanes.
   */
  async validate(
    apiKey: string,
    clientCode: string,
  ): Promise<KeyValidationResult> {
    if (!apiKey) {
      return {
        ok: false,
        status: 401,
        code: "MISSING_KEY",
        message: "Unauthorized: Missing API Key",
      };
    }
    if (!clientCode) {
      return {
        ok: false,
        status: 400,
        code: "MISSING_TENANT",
        message: "Missing X-Tenant-Id header",
      };
    }

    const cacheKey = `${apiKey}|${clientCode}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > this.now()) {
        return cached.context;
      }
      this.cache.delete(cacheKey);
    }

    let result: KeyValidationResult;
    if (apiKey.startsWith(INTERNAL_KEY_PREFIX)) {
      result = this.validateInternal(apiKey, clientCode);
    } else if (
      apiKey.startsWith(EXTERNAL_KEY_PREFIX) ||
      apiKey.startsWith("ecod_live_sk_")
    ) {
      result = await this.validateExternal(apiKey, clientCode);
    } else {
      result = {
        ok: false,
        status: 401,
        code: "UNKNOWN_KEY_PREFIX",
        message: "Unauthorized: Unknown API Key prefix",
      };
    }

    if (result.ok) {
      this.cache.set(cacheKey, {
        context: result,
        expiresAt: this.now() + this.cacheTtlMs,
      });
    }
    return result;
  }

  /** Drop a single cache entry. Used by rotation flows in saas. */
  invalidate(apiKey: string, clientCode: string): void {
    this.cache.delete(`${apiKey}|${clientCode}`);
  }

  /** Drop every cached entry. Used by tests + emergency rotations. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Number of live (non-expired) cache entries. Useful for tests + ops. */
  cacheSize(): number {
    const now = this.now();
    let live = 0;
    for (const entry of this.cache.values()) {
      if (entry.expiresAt > now) live += 1;
    }
    return live;
  }

  // ── Internal lane ────────────────────────────────────────────────────────

  private validateInternal(
    apiKey: string,
    clientCode: string,
  ): KeyValidationResult {
    const candidate = Buffer.from(apiKey);
    if (!constantTimeAnyEqual(candidate, this.internalKeys)) {
      return {
        ok: false,
        status: 401,
        code: "INVALID_INTERNAL_KEY",
        message: "Unauthorized: Invalid internal API Key",
      };
    }
    return { ok: true, kind: "internal", tenantId: clientCode };
  }

  // ── External lane ────────────────────────────────────────────────────────

  private async validateExternal(
    apiKey: string,
    clientCode: string,
  ): Promise<KeyValidationResult> {
    let row: OrgRow | undefined;
    try {
      const { rows } = await this.pool.query<OrgRow>(
        `SELECT id, client_code, status
				 FROM ecodrix_organizations
				 WHERE api_key = $1
				 LIMIT 1`,
        [apiKey],
      );
      row = rows[0];
    } catch (err) {
      const message = err instanceof Error ? err.message : "Database error";
      return {
        ok: false,
        status: 500,
        code: "DB_ERROR",
        message: `Key lookup failed: ${message}`,
      };
    }

    if (!row) {
      return {
        ok: false,
        status: 401,
        code: "INVALID_EXTERNAL_KEY",
        message: "Unauthorized: Invalid API Key",
      };
    }
    if (row.client_code !== clientCode) {
      return {
        ok: false,
        status: 403,
        code: "TENANT_MISMATCH",
        message: "Tenant ID does not match API Key",
      };
    }
    if (row.status !== "active") {
      return {
        ok: false,
        status: 403,
        code: "ORG_SUSPENDED",
        message: "Organization is suspended",
      };
    }

    return {
      ok: true,
      kind: "external",
      tenantId: row.client_code,
      orgId: row.id,
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a {@link KeyValidator} from `process.env.ERIX_INTERNAL_KEY` and
 * a caller-supplied `pg.Pool`. Pulled out as a separate helper so tests
 * can construct the class directly with a fixture pool.
 */
export function createKeyValidator(
  options: Omit<KeyValidatorOptions, "internalKeys"> & {
    internalKeys?: readonly string[];
  },
): KeyValidator {
  return new KeyValidator({
    pool: options.pool,
    internalKeys:
      options.internalKeys ?? parseInternalKeys(process.env.ERIX_INTERNAL_KEY),
    cacheTtlMs: options.cacheTtlMs,
    now: options.now,
  });
}
