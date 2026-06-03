/**
 * @file auth.ts
 * @module Server/Middleware/Auth
 *
 * Express auth middleware for erix-store.
 *
 * Delegates the actual key check to {@link KeyValidator}, which knows
 * how to distinguish internal `eint_…` keys from per-org external
 * `erix_…` keys (see `keyValidator.ts`). On success the validated
 * tenant context is attached to the request:
 *
 *   - `req.tenantId`   — tenant the caller is authorised to operate on
 *   - `req.tenantKind` — `"internal"` or `"external"`
 *   - `req.orgId`      — only set for external lane (org row PK)
 *
 * Two ways to wire it up:
 *
 *   1. Default — `app.use(authMiddleware)`. Builds a singleton
 *      validator on first request from `DATABASE_URL` +
 *      `ERIX_INTERNAL_KEY`. Backward-compatible with the previous
 *      env-shared-secret middleware shape; existing call sites in
 *      `app.ts` keep working unchanged.
 *
 *   2. Inject — `app.use(createAuthMiddleware({ validator }))`. Used
 *      by tests and by callers that already own a `pg.Pool` they want
 *      to share, avoiding a second connection pool just for auth.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Pool } from "pg";
import {
  createKeyValidator,
  type KeyValidator,
  parseInternalKeys,
} from "./keyValidator.js";

// ─── Public middleware factory ────────────────────────────────────────────────

export interface AuthMiddlewareOptions {
  /**
   * Pre-built validator. When omitted, the middleware lazily constructs
   * a singleton validator from environment variables on first request.
   */
  validator?: KeyValidator;
}

/**
 * Build a request handler that validates `(x-erix-key, x-tenant-id)`
 * via {@link KeyValidator} and attaches the resolved tenant context
 * to the request before delegating to the next handler.
 */
export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): RequestHandler {
  const injected = options.validator;

  return async function authHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const apiKey = (req.headers["x-erix-key"] as string | undefined) ?? "";
    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "";

    const validator = injected ?? getDefaultValidator();
    const result = await validator.validate(apiKey, tenantId);

    if (!result.ok) {
      return res
        .status(result.status)
        .json({ error: result.message, code: result.code });
    }

    req.tenantId = result.tenantId;
    req.tenantKind = result.kind;
    if (result.kind === "external") {
      req.orgId = result.orgId;
    } else {
      // Belt-and-braces: clear any stale value if the request object
      // is being reused (uncommon, but cheap to guard against).
      req.orgId = undefined;
    }

    next();
  };
}

// ─── Default singleton (back-compat with `app.use(authMiddleware)`) ───────────

let cachedDefaultValidator: KeyValidator | null = null;
let cachedDefaultPool: Pool | null = null;

function getDefaultValidator(): KeyValidator {
  if (cachedDefaultValidator) return cachedDefaultValidator;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "[auth] Cannot build default key validator — DATABASE_URL is not set. " +
        "Either set DATABASE_URL or pass an injected validator via createAuthMiddleware({ validator }).",
    );
  }

  cachedDefaultPool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: databaseUrl.includes("supabase.com")
      ? { rejectUnauthorized: false }
      : undefined,
  });

  cachedDefaultValidator = createKeyValidator({
    pool: cachedDefaultPool,
    internalKeys: parseInternalKeys(process.env.ERIX_INTERNAL_KEY),
  });

  return cachedDefaultValidator;
}

/**
 * Test/ops hook — drop the cached singleton (and close its pool) so
 * the next request rebuilds from current environment values. Safe to
 * call from `afterEach` in tests; no-op when nothing is cached.
 */
export async function resetDefaultAuthForTests(): Promise<void> {
  cachedDefaultValidator = null;
  if (cachedDefaultPool) {
    const pool = cachedDefaultPool;
    cachedDefaultPool = null;
    await pool.end();
  }
}

/**
 * Default middleware instance. Backwards-compatible drop-in for the
 * previous env-shared-secret middleware: same export name, same
 * `(req, res, next)` shape, registered the same way in `app.ts`.
 */
export const authMiddleware: RequestHandler = (req, res, next) => {
  // Build the inner handler lazily so importing this module has no
  // side effects (no Pool creation, no env reads at module load time).
  const handler = createAuthMiddleware();
  return handler(req, res, next);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Utility to prefix keys with tenantId. Unchanged from the previous
 * implementation — kept here so the many route files that import it
 * don't need to touch their import lines.
 */
export const getTenantKey = (tenantId: string, key: string) => {
  return `${tenantId}:${key}`;
};
