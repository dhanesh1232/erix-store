import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PersistenceManager } from "../../src/core/Persistence.js";
import type { ErixStore } from "../../src/core/Store.js";
import type { RateLimiterService } from "../../src/services/RateLimiter.js";

// The 5-minute auto-save fires save() as `void`. A Postgres connect timeout
// (box stalled, proxy blip) rejected pool.connect() outside save()'s try: an
// unhandled rejection that killed the store, so every enqueue failed with
// "fetch failed" until someone restarted it (local, 17 Oct, ~20 min).
describe("Persistence auto-save when Postgres can't be reached", () => {
	it("logs and keeps the process alive instead of an unhandled rejection", async () => {
		const pool = {
			connect: vi
				.fn()
				.mockRejectedValue(
					new Error("Connection terminated due to connection timeout"),
				),
		} as unknown as Pool;
		const persistence = new PersistenceManager(
			pool,
			{ exportAll: () => ({}) } as unknown as ErixStore,
			{ export: () => ({}) } as unknown as RateLimiterService,
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const logs = vi.spyOn(console, "log").mockImplementation(() => {});
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			await expect(persistence.save()).resolves.toBeUndefined();
			persistence.startAutoSave(5);
			await new Promise((r) => setTimeout(r, 30));
			persistence.stopAutoSave();
			await new Promise((r) => setTimeout(r, 10));
			// The direct call plus at least one timer tick, each failing quietly.
			expect(vi.mocked(pool.connect).mock.calls.length).toBeGreaterThan(1);
			expect(unhandled).not.toHaveBeenCalled();
			expect(errors).toHaveBeenCalledWith(
				"[Persistence] Snapshot save failed:",
				expect.objectContaining({
					message: expect.stringContaining("connection timeout"),
				}),
			);
		} finally {
			process.off("unhandledRejection", unhandled);
			persistence.stopAutoSave();
			errors.mockRestore();
			logs.mockRestore();
		}
	});
});
