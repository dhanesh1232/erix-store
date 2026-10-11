/**
 * @file internal-only.test.ts
 *
 * The cache, job queue, locks, rate limits and semantic cache share ONE
 * keyspace across tenants, so only internal (`eint_`) callers may use them. A
 * tenant (external) key gets 403 there but keeps its own tenant-prefixed KV.
 * A WebSocket frame with no key is rejected — never run under a server env key.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import { createApp } from "../../src/server/app.js";
import type { KeyValidator } from "../../src/server/middleware/keyValidator.js";
import { createRouteHandler } from "../../src/server/wsRouteHandler.js";
import { CacheService } from "../../src/services/CacheService.js";
import { PubSubService } from "../../src/services/PubSub.js";
import { RateLimiterService } from "../../src/services/RateLimiter.js";

const INTERNAL = "eint_test";
const TENANT = "erix_test";

/** Internal key → any tenant; tenant key → locked to its own client code. */
const validator: KeyValidator = {
	async validate(apiKey, clientCode) {
		if (apiKey === INTERNAL)
			return { ok: true, kind: "internal", tenantId: clientCode };
		if (apiKey === TENANT)
			return { ok: true, kind: "external", tenantId: "ACME", orgId: "org-a" };
		return {
			ok: false,
			status: 401,
			code: "MISSING_KEY",
			message: "Unauthorized",
		};
	},
	invalidate() {},
	clearCache() {},
	cacheSize() {
		return 0;
	},
} as KeyValidator;

let store: ErixStore;
let rateLimiter: RateLimiterService;

function build() {
	store = new ErixStore();
	rateLimiter = new RateLimiterService();
	const app = createApp(store, new PubSubService(), rateLimiter, {
		cache: new CacheService(),
		authValidator: validator,
	});
	return createRouteHandler(app);
}

afterEach(() => {
	store?.ttlManager.stopSweep();
	rateLimiter?.destroy();
});

describe("shared namespaces are internal-only", () => {
	it("refuses a tenant key on /cache (no reading or planting cache entries)", async () => {
		const call = build();
		const res = await call(
			"POST",
			"/cache/auth:session:abc",
			{ value: { userId: "victim" } },
			{ "x-erix-key": TENANT, "x-tenant-id": "ACME" },
		);
		expect(res.status).toBe(403);
	});

	it("refuses a tenant key on /ratelimit", async () => {
		const call = build();
		const auth = { "x-erix-key": TENANT, "x-tenant-id": "ACME" };
		expect(
			(
				await call(
					"POST",
					"/ratelimit/check",
					{ key: "k", limit: 1, window: 60 },
					auth,
				)
			).status,
		).toBe(403);
	});

	it("still serves the tenant its own KV", async () => {
		const call = build();
		const auth = { "x-erix-key": TENANT, "x-tenant-id": "ACME" };
		const set = await call("POST", "/core/set", { key: "k", value: "v" }, auth);
		expect(set.status).toBe(200);
	});

	it("lets the internal key use the shared cache", async () => {
		const call = build();
		const res = await call(
			"POST",
			"/cache/some-key",
			{ value: 1 },
			{ "x-erix-key": INTERNAL, "x-tenant-id": "server" },
		);
		expect(res.status).toBe(200);
	});

	it("rejects a WebSocket frame with no key instead of using a server env key", async () => {
		const prev = process.env.ERIX_API_KEY;
		process.env.ERIX_API_KEY = INTERNAL;
		try {
			const call = build();
			const res = await call(
				"POST",
				"/cache/x",
				{ value: 1 },
				{ "x-tenant-id": "server" },
			);
			expect(res.status).toBe(401);
		} finally {
			process.env.ERIX_API_KEY = prev;
		}
	});
});
