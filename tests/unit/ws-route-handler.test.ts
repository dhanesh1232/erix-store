/**
 * @file ws-route-handler.test.ts
 *
 * Tests for the WebSocket route handler bridge that routes WS frames
 * through the Express application middleware stack.
 */

import express from "express";
import { describe, expect, it } from "vitest";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";

describe("WebSocket Route Handler (createRouteHandler)", () => {
	it("should route a GET request through Express and return the response", async () => {
		const app = express();
		app.use(express.json());
		app.get("/health", (_req, res) => {
			res.json({ status: "ok" });
		});

		const handler = createRouteHandler(app);
		const result = await handler("GET", "/health");

		expect(result.status).toBe(200);
		expect(result.data).toEqual({ status: "ok" });
	});

	it("should route a POST request with body through Express", async () => {
		const app = express();
		app.use(express.json());
		app.post("/echo", (req, res) => {
			res.json({ received: req.body });
		});

		const handler = createRouteHandler(app);
		const result = await handler("POST", "/echo", { key: "hello", value: 42 });

		expect(result.status).toBe(200);
		expect(result.data).toEqual({ received: { key: "hello", value: 42 } });
	});

	it("should pass query params from the params argument", async () => {
		const app = express();
		app.use(express.json());
		app.get("/search", (req, res) => {
			res.json({ query: req.query });
		});

		const handler = createRouteHandler(app);
		const result = await handler("GET", "/search", undefined, {
			q: "test",
			limit: "10",
		});

		expect(result.status).toBe(200);
		expect(result.data).toEqual({ query: { q: "test", limit: "10" } });
	});

	it("should return 404 for unmatched routes", async () => {
		const app = express();
		app.use(express.json());
		app.get("/exists", (_req, res) => {
			res.json({ found: true });
		});

		const handler = createRouteHandler(app);
		const result = await handler("GET", "/does-not-exist");

		expect(result.status).toBe(404);
	});

	it("should handle middleware that sets status codes", async () => {
		const app = express();
		app.use(express.json());
		app.post("/validate", (req, res) => {
			if (!req.body.name) {
				return res.status(400).json({ error: "name is required" });
			}
			res.json({ ok: true });
		});

		const handler = createRouteHandler(app);

		const badResult = await handler("POST", "/validate", {});
		expect(badResult.status).toBe(400);
		expect(badResult.data).toEqual({ error: "name is required" });

		const goodResult = await handler("POST", "/validate", { name: "test" });
		expect(goodResult.status).toBe(200);
		expect(goodResult.data).toEqual({ ok: true });
	});

	it("should handle DELETE requests", async () => {
		const app = express();
		app.use(express.json());
		app.delete("/item", (req, res) => {
			res.json({ deleted: req.body.id });
		});

		const handler = createRouteHandler(app);
		const result = await handler("DELETE", "/item", { id: "abc123" });

		expect(result.status).toBe(200);
		expect(result.data).toEqual({ deleted: "abc123" });
	});

	it("should work with Express Router sub-routes", async () => {
		const app = express();
		app.use(express.json());

		const router = express.Router();
		router.get("/get", (_req, res) => {
			res.json({ value: "from-core" });
		});
		app.use("/core", router);

		const handler = createRouteHandler(app);
		const result = await handler("GET", "/core/get");

		expect(result.status).toBe(200);
		expect(result.data).toEqual({ value: "from-core" });
	});

	it("should handle concurrent requests correctly", async () => {
		const app = express();
		app.use(express.json());
		app.post("/delay", (req, res) => {
			const delay = req.body.delay ?? 0;
			setTimeout(() => {
				res.json({ id: req.body.id, delayed: delay });
			}, delay);
		});

		const handler = createRouteHandler(app);

		// Send multiple concurrent requests
		const results = await Promise.all([
			handler("POST", "/delay", { id: 1, delay: 10 }),
			handler("POST", "/delay", { id: 2, delay: 5 }),
			handler("POST", "/delay", { id: 3, delay: 1 }),
		]);

		expect(results[0].data).toEqual({ id: 1, delayed: 10 });
		expect(results[1].data).toEqual({ id: 2, delayed: 5 });
		expect(results[2].data).toEqual({ id: 3, delayed: 1 });
	});
});
