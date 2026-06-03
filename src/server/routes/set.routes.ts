import { Router } from "express";
import type { ErixStore } from "../../core/Store.js";
import { getTenantKey } from "../middleware/auth.js";

export const createSetRoutes = (store: ErixStore) => {
	const router = Router();

	// Sets
	router.post("/sadd", (req, res, next) => {
		try {
			const { key, value } = req.body;
			const tenantKey = getTenantKey(req.tenantId, key);
			store.reserveKey(tenantKey, "set");
			const added = store.sets.sadd(tenantKey, value);
			res.json({ added });
		} catch (err) {
			next(err);
		}
	});

	router.get("/smembers", (req, res, next) => {
		try {
			const { key } = req.query;
			const tenantKey = getTenantKey(req.tenantId, key as string);
			if (store.isExpired(tenantKey)) {
				return res.json({ members: [] });
			}
			store.types.assertType(tenantKey, "set");
			res.json({ members: store.sets.smembers(tenantKey) });
		} catch (err) {
			next(err);
		}
	});

	// Sorted Sets
	router.post("/zadd", (req, res, next) => {
		try {
			const { key, score, value } = req.body;
			const tenantKey = getTenantKey(req.tenantId, key);
			store.reserveKey(tenantKey, "zset");
			const added = store.sortedSets.zadd(tenantKey, score, value);
			res.json({ added });
		} catch (err) {
			next(err);
		}
	});

	router.get("/zrange", (req, res, next) => {
		try {
			const { key, start, stop } = req.query;
			const tenantKey = getTenantKey(req.tenantId, key as string);
			if (store.isExpired(tenantKey)) {
				return res.json({ members: [] });
			}
			store.types.assertType(tenantKey, "zset");
			res.json({
				members: store.sortedSets.zrange(
					tenantKey,
					Number(start),
					Number(stop),
				),
			});
		} catch (err) {
			next(err);
		}
	});

	return router;
};
