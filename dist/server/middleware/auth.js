import { timingSafeEqual } from "node:crypto";
export const authMiddleware = (req, res, next) => {
    const apiKey = req.headers["x-erix-key"];
    const tenantId = req.headers["x-tenant-id"];
    const expectedKey = process.env.ERIX_API_KEY ?? "";
    // Use timing-safe comparison to prevent timing-attack enumeration of the key
    const isValid = apiKey.length === expectedKey.length &&
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
export const getTenantKey = (tenantId, key) => {
    return `${tenantId}:${key}`;
};
