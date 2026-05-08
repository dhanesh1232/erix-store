import type { Router } from "express";
import { Router as createRouter } from "express";
import type { CacheService } from "../../services/CacheService.js";

export function createCacheRoutes(cache: CacheService): Router {
	const router = createRouter();

	/**
	 * Get value from cache
	 * GET /cache/:key
	 */
	router.get("/:key", (req, res) => {
		try {
			const { key } = req.params;
			const value = cache.get(key);

			if (value === null) {
				return res.status(404).json({ success: false, error: "Key not found" });
			}

			res.json({ success: true, value });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Set value in cache
	 * POST /cache/:key
	 */
	router.post("/:key", (req, res) => {
		try {
			const { key } = req.params;
			const { value, ttl, tags, metadata } = req.body;

			cache.set(key, value, { ttl, tags, metadata });
			res.json({ success: true });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Delete key from cache
	 * DELETE /cache/:key
	 */
	router.delete("/:key", (req, res) => {
		try {
			const { key } = req.params;
			const success = cache.delete(key);

			if (!success) {
				return res.status(404).json({ success: false, error: "Key not found" });
			}

			res.json({ success: true });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Check if key exists
	 * HEAD /cache/:key
	 */
	router.head("/:key", (req, res) => {
		try {
			const { key } = req.params;
			const exists = cache.has(key);

			if (!exists) {
				return res.status(404).end();
			}

			res.status(200).end();
		} catch (_error: unknown) {
			res.status(500).end();
		}
	});

	/**
	 * Get multiple keys
	 * POST /cache/mget
	 */
	router.post("/mget", (req, res) => {
		try {
			const { keys } = req.body;
			const result = cache.mget(keys);
			const data = Object.fromEntries(result);

			res.json({ success: true, data });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Set multiple keys
	 * POST /cache/mset
	 */
	router.post("/mset", (req, res) => {
		try {
			const { entries } = req.body;
			cache.mset(entries);
			res.json({ success: true });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Invalidate by tag
	 * DELETE /cache/tags/:tag
	 */
	router.delete("/tags/:tag", (req, res) => {
		try {
			const { tag } = req.params;
			const count = cache.invalidateByTag(tag);
			res.json({ success: true, count });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Invalidate by multiple tags
	 * POST /cache/tags/invalidate
	 */
	router.post("/tags/invalidate", (req, res) => {
		try {
			const { tags } = req.body;
			const count = cache.invalidateByTags(tags);
			res.json({ success: true, count });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Invalidate by pattern
	 * POST /cache/pattern/invalidate
	 */
	router.post("/pattern/invalidate", (req, res) => {
		try {
			const { pattern } = req.body;
			const count = cache.invalidateByPattern(pattern);
			res.json({ success: true, count });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Get cache statistics
	 * GET /cache/_stats
	 */
	router.get("/_stats", (_req, res) => {
		try {
			const stats = cache.getStats();
			res.json({ success: true, stats });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Reset statistics
	 * POST /cache/_stats/reset
	 */
	router.post("/_stats/reset", (_req, res) => {
		try {
			cache.resetStats();
			res.json({ success: true });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Get all keys
	 * GET /cache/_keys
	 */
	router.get("/_keys", (_req, res) => {
		try {
			const keys = cache.keys();
			res.json({ success: true, keys, count: keys.length });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Get keys by tag
	 * GET /cache/tags/:tag/keys
	 */
	router.get("/tags/:tag/keys", (req, res) => {
		try {
			const { tag } = req.params;
			const keys = cache.keysByTag(tag);
			res.json({ success: true, keys, count: keys.length });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Get cache entry metadata
	 * GET /cache/:key/meta
	 */
	router.get("/:key/meta", (req, res) => {
		try {
			const { key } = req.params;
			const entry = cache.getEntry(key);

			if (!entry) {
				return res.status(404).json({ success: false, error: "Key not found" });
			}

			res.json({ success: true, entry });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Get memory usage
	 * GET /cache/_memory
	 */
	router.get("/_memory", (_req, res) => {
		try {
			const memory = cache.getMemoryUsage();
			res.json({ success: true, memory });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Clear all cache
	 * DELETE /cache/_all
	 */
	router.delete("/_all", (_req, res) => {
		try {
			cache.clear();
			res.json({ success: true });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	return router;
}
