import { Router } from "express";
import type { RateLimiterService } from "../../services/RateLimiter.js";

export function createRateLimitRoutes(rateLimiter: RateLimiterService) {
	const router = Router();

	router.post("/check", async (req, res) => {
		const { key, limit, window } = req.body;
		if (!key || !limit || !window) {
			return res.status(400).json({ error: "Missing key, limit or window" });
		}
		const result = await rateLimiter.check(key, limit, window);
		res.json(result);
	});

	// Legacy endpoint support for client
	router.post("/", async (req, res) => {
		const { key, limit, window } = req.body;
		if (!key || !limit || !window) {
			return res.status(400).json({ error: "Missing key, limit or window" });
		}
		const result = await rateLimiter.check(key, limit, window);
		res.json(result);
	});

	return router;
}
