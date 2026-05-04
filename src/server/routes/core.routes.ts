import { Router } from "express";
import type { ErixStore } from "../../core/Store.js";
import { getTenantKey } from "../middleware/auth.js";

export const createCoreRoutes = (store: ErixStore) => {
	const router = Router();

	router.post("/set", (req, res) => {
		const { key, value, ttl } = req.body;
		const tenantKey = getTenantKey((req as any).tenantId, key);

		store.strings.set(tenantKey, value);
		if (ttl) {
			store.ttlManager.set(tenantKey, ttl);
		}
		res.json({ success: true });
	});

	router.get("/get", (req, res) => {
		const { key } = req.query;
		const tenantKey = getTenantKey((req as any).tenantId, key as string);

		if (store.isExpired(tenantKey)) {
			return res.json({ value: null });
		}

		res.json({ value: store.strings.get(tenantKey) });
	});

	router.delete("/del", (req, res) => {
		const { key } = req.body;
		const tenantKey = getTenantKey((req as any).tenantId, key);

		store.strings.delete(tenantKey);
		store.ttlManager.delete(tenantKey);
		res.json({ success: true });
	});

	return router;
};
