import { Router } from "express";
import type { SemanticCacheService } from "../../services/SemanticCacheService.js";

export const createSemanticCacheRoutes = (semantic: SemanticCacheService) => {
	const router = Router();

	/**
	 * Store a value with its embedding
	 * POST /semantic/:key
	 * Body: { text: string, value: unknown, ttlMs?: number, tags?: string[] }
	 */
	router.post("/:key", async (req, res) => {
		try {
			const { key } = req.params;
			const { text, value, ttlMs, tags } = req.body as {
				text: string;
				value: unknown;
				ttlMs?: number;
				tags?: string[];
			};

			if (!text || value === undefined) {
				return res.status(400).json({ success: false, error: "text and value are required" });
			}

			await semantic.set(key, text, value, ttlMs, tags);
			res.json({ success: true, key });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Exact key lookup
	 * GET /semantic/:key
	 */
	router.get("/:key", (req, res) => {
		try {
			const { key } = req.params;
			const value = semantic.get(key);
			if (value === null) return res.status(404).json({ success: false, error: "Not found" });
			res.json({ success: true, value });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Semantic (similarity) lookup
	 * POST /semantic/search
	 * Body: { query: string, threshold?: number }
	 */
	router.post("/search", async (req, res) => {
		try {
			const { query, threshold } = req.body as { query: string; threshold?: number };
			if (!query) return res.status(400).json({ success: false, error: "query is required" });

			const result = await semantic.semanticGet(query, threshold);
			if (!result) return res.status(404).json({ success: false, error: "No similar entry found" });

			res.json({ success: true, ...result });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Invalidate by tag
	 * DELETE /semantic/tags/:tag
	 */
	router.delete("/tags/:tag", (req, res) => {
		try {
			const { tag } = req.params;
			const count = semantic.invalidateByTag(tag);
			res.json({ success: true, count });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Delete a key
	 * DELETE /semantic/:key
	 */
	router.delete("/:key", (req, res) => {
		try {
			const { key } = req.params;
			semantic.delete(key);
			res.json({ success: true });
		} catch (error: unknown) {
			res.status(500).json({ success: false, error: (error as Error).message });
		}
	});

	/**
	 * Stats
	 * GET /semantic/_stats
	 */
	router.get("/_stats", (_req, res) => {
		res.json({ success: true, size: semantic.size(), keys: semantic.keys() });
	});

	return router;
};
