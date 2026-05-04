import type { NextFunction, Request, Response } from "express";

export const authMiddleware = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	const apiKey = req.headers["x-erix-key"] as string;
	const tenantId = req.headers["x-tenant-id"] as string;

	if (!apiKey || apiKey !== process.env.ERIX_API_KEY) {
		return res.status(401).json({ error: "Unauthorized: Invalid API Key" });
	}

	if (!tenantId) {
		return res.status(400).json({ error: "Missing X-Tenant-Id header" });
	}

	// Attach to request for use in routes
	(req as any).tenantId = tenantId;
	next();
};

/**
 * Utility to prefix keys with tenantId
 */
export const getTenantKey = (tenantId: string, key: string) => {
	return `${tenantId}:${key}`;
};
