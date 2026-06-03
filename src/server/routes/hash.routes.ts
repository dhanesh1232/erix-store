import { Router } from "express";
import type { ErixStore } from "../../core/Store.js";
import { getTenantKey } from "../middleware/auth.js";

export const createHashRoutes = (store: ErixStore) => {
	const router = Router();

	router.post("/hset", (req, res, next) => {
		try {
			const { key, field, value } = req.body;
			const tenantKey = getTenantKey(req.tenantId, key);
			store.reserveKey(tenantKey, "hash");
			store.hashes.hset(tenantKey, field, value);
			res.json({ success: true });
		} catch (err) {
			next(err);
		}
	});

	router.get("/hget", (req, res, next) => {
		try {
			const { key, field } = req.query;
			const tenantKey = getTenantKey(req.tenantId, key as string);
			if (store.isExpired(tenantKey)) {
				return res.json({ value: null });
			}
			store.types.assertType(tenantKey, "hash");
			res.json({ value: store.hashes.hget(tenantKey, field as string) });
		} catch (err) {
			next(err);
		}
	});

	router.get("/hgetall", (req, res, next) => {
		try {
			const { key } = req.query;
			const tenantKey = getTenantKey(req.tenantId, key as string);
			if (store.isExpired(tenantKey)) {
				return res.json({ data: null });
			}
			store.types.assertType(tenantKey, "hash");
			res.json({ data: store.hashes.hgetall(tenantKey) });
		} catch (err) {
			next(err);
		}
	});

	return router;
};
