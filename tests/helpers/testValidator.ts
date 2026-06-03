/**
 * @file testValidator.ts
 *
 * Provides a simple in-memory KeyValidator for integration tests.
 * Accepts any non-empty API key that matches the configured test key,
 * and treats the supplied tenant ID as valid. This avoids requiring
 * DATABASE_URL or a real Postgres connection in unit/integration tests.
 */

import type {
  KeyValidationResult,
  KeyValidator,
} from "../../src/server/middleware/keyValidator.js";

/**
 * Creates a KeyValidator stub that accepts a single shared key.
 * Mirrors the old `ERIX_API_KEY` env-var behaviour used by all
 * integration tests before the per-org auth refactor.
 */
export function createTestValidator(acceptedKey: string): KeyValidator {
  const validator: KeyValidator = {
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
      if (apiKey !== acceptedKey) {
        return {
          ok: false,
          status: 401,
          code: "INVALID_INTERNAL_KEY",
          message: "Unauthorized: Invalid API Key",
        };
      }
      return { ok: true, kind: "internal", tenantId: clientCode };
    },
    invalidate() {},
    clearCache() {},
    cacheSize() {
      return 0;
    },
  };
  return validator;
}
