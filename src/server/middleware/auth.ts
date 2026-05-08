import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const authMiddleware = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	const apiKey = req.headers["x-erix-key"] as string;
	const tenantId = req.headers["x-tenant-id"] as string;

	const expectedKey = process.env.ERIX_API_KEY ?? "";

	// Use timing-safe comparison to prevent timing-attack enumeration of the key
	const isValid =
		apiKey.length === expectedKey.length &&
		timingSafeEqual(Buffer.from(apiKey), Buffer.from(expectedKey));

	if (!apiKey || !isValid) {
		return res.status(401).json({ error: "Unauthorized: Invalid API Key" });
	}

	if (!tenantId) {
		return res.status(400).json({ error: "Missing X-Tenant-Id header" });
	}

	// Attach to request for use in routes
	req.tenantId = tenantId;
	next();
};

/**
 * Utility to prefix keys with tenantId
 */
export const getTenantKey = (tenantId: string, key: string) => {
	return `${tenantId}:${key}`;
};
