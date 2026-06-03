/**
 * Express Request augmentation for erix-store.
 *
 * The auth middleware attaches the resolved tenant context to every
 * authenticated request. Declaring it here means every route file
 * gets proper typing without needing `(req as any).tenantId` anywhere.
 */

declare namespace Express {
  interface Request {
    /** Populated by authMiddleware from the x-tenant-id header. */
    tenantId: string;
    /**
     * Lane the caller authenticated through. Set by authMiddleware:
     *   - `"internal"` — `eint_…` key from the operator-controlled
     *     `ERIX_INTERNAL_KEY` env list. Free to impersonate any
     *     tenantId.
     *   - `"external"` — `erix_…` key minted in
     *     `ecodrix_organizations.api_key`. tenantId is bound to the
     *     org's `client_code`.
     *
     * Optional in the type for back-compat with code paths that ran
     * before the per-org validator was wired up; in practice every
     * authenticated request has it set.
     */
    tenantKind?: "internal" | "external";
    /**
     * Org row PK, only set when `tenantKind === "external"`. Used by
     * audit-logging and rotation flows so they can write back to the
     * exact `ecodrix_organizations` row that authorised the request.
     */
    orgId?: string;
  }
}
