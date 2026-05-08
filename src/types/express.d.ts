/**
 * Express Request augmentation for erix-store.
 *
 * The auth middleware attaches `tenantId` to every authenticated request.
 * Declaring it here means every route file gets proper typing without
 * needing `(req as any).tenantId` anywhere.
 */

declare namespace Express {
	interface Request {
		/** Populated by authMiddleware from the x-tenant-id header */
		tenantId: string;
	}
}
