import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeapTTLManager } from "../../src/core/HeapTTLManager";

describe("HeapTTLManager", () => {
	let manager: HeapTTLManager;
	let expiredKeys: string[];
	let onExpire: (key: string) => void;

	beforeEach(() => {
		vi.useFakeTimers();
		expiredKeys = [];
		onExpire = (key: string) => expiredKeys.push(key);
		manager = new HeapTTLManager(onExpire, 500);
	});

	afterEach(() => {
		manager.stopSweep();
		vi.useRealTimers();
	});

	describe("set", () => {
		it("should set a TTL for a key", () => {
			manager.set("key1", 10);
			expect(manager.getTTL("key1")).toBeGreaterThan(0);
			expect(manager.getTTL("key1")).toBeLessThanOrEqual(10);
		});

		it("should overwrite TTL when set again for the same key", () => {
			manager.set("key1", 5);
			manager.set("key1", 20);
			expect(manager.getTTL("key1")).toBeGreaterThan(5);
			expect(manager.getTTL("key1")).toBeLessThanOrEqual(20);
		});
	});

	describe("delete", () => {
		it("should invalidate a key (lazy deletion)", () => {
			manager.set("key1", 10);
			manager.delete("key1");
			expect(manager.getTTL("key1")).toBe(-1);
		});

		it("should not invoke onExpire when sweep encounters invalidated entry", () => {
			manager.set("key1", 1);
			manager.delete("key1");

			// Advance past expiration and trigger sweep
			vi.advanceTimersByTime(1500);

			expect(expiredKeys).not.toContain("key1");
		});

		it("should be a no-op for non-existent key", () => {
			expect(() => manager.delete("nonexistent")).not.toThrow();
		});
	});

	describe("isExpired", () => {
		it("should return false for non-expired key", () => {
			manager.set("key1", 10);
			expect(manager.isExpired("key1")).toBe(false);
		});

		it("should return true for expired key and trigger onExpire", () => {
			// Use a long sweep interval so we can test isExpired in isolation
			manager.stopSweep();
			const noSweepManager = new HeapTTLManager(onExpire, 60000);
			noSweepManager.set("key1", 1);

			vi.advanceTimersByTime(1001);
			expect(noSweepManager.isExpired("key1")).toBe(true);
			expect(expiredKeys).toContain("key1");

			noSweepManager.stopSweep();
		});

		it("should return false for key with no TTL", () => {
			expect(manager.isExpired("nonexistent")).toBe(false);
		});
	});

	describe("getTTL", () => {
		it("should return remaining TTL in seconds", () => {
			manager.set("key1", 10);
			vi.advanceTimersByTime(3000);
			expect(manager.getTTL("key1")).toBe(7);
		});

		it("should return -1 for key with no TTL", () => {
			expect(manager.getTTL("nonexistent")).toBe(-1);
		});

		it("should return -1 for expired key", () => {
			manager.set("key1", 1);
			vi.advanceTimersByTime(2000);
			// After expiration, getTTL should return -1
			expect(manager.getTTL("key1")).toBe(-1);
		});
	});

	describe("sweep", () => {
		it("should expire keys when sweep interval fires", () => {
			manager.set("key1", 1);
			manager.set("key2", 2);

			// Advance 1.5s — key1 should expire on sweep, key2 should not
			vi.advanceTimersByTime(1500);

			expect(expiredKeys).toContain("key1");
			expect(expiredKeys).not.toContain("key2");
		});

		it("should expire multiple keys in order", () => {
			manager.set("key1", 1);
			manager.set("key2", 2);
			manager.set("key3", 3);

			// Advance 2.5s — key1 and key2 should expire
			vi.advanceTimersByTime(2500);

			expect(expiredKeys).toContain("key1");
			expect(expiredKeys).toContain("key2");
			expect(expiredKeys).not.toContain("key3");
		});

		it("should not expire keys that are not yet due", () => {
			manager.set("key1", 10);

			vi.advanceTimersByTime(5000);

			expect(expiredKeys).not.toContain("key1");
		});

		it("should skip invalidated entries without calling onExpire", () => {
			manager.set("key1", 1);
			manager.set("key2", 1);
			manager.delete("key1");

			vi.advanceTimersByTime(1500);

			expect(expiredKeys).not.toContain("key1");
			expect(expiredKeys).toContain("key2");
		});

		it("should handle overwritten TTL correctly during sweep", () => {
			manager.set("key1", 1); // expires at t+1s
			manager.set("key1", 5); // new TTL: expires at t+5s

			// Advance 1.5s — old entry expires but is invalidated, new entry not yet due
			vi.advanceTimersByTime(1500);

			expect(expiredKeys).not.toContain("key1");
			expect(manager.getTTL("key1")).toBeGreaterThan(0);
		});

		it("should use configurable sweep interval", () => {
			manager.stopSweep();
			const customManager = new HeapTTLManager(onExpire, 1000);
			customManager.set("key1", 1);

			// At 500ms, sweep hasn't fired yet (interval is 1000ms)
			vi.advanceTimersByTime(500);
			expect(expiredKeys).not.toContain("key1");

			// At 1000ms, sweep fires and key1 is expired
			vi.advanceTimersByTime(500);
			expect(expiredKeys).toContain("key1");

			customManager.stopSweep();
		});
	});

	describe("exportExpirations", () => {
		it("should export all active expirations", () => {
			manager.set("key1", 10);
			manager.set("key2", 20);

			const exported = manager.exportExpirations();

			expect(Object.keys(exported)).toHaveLength(2);
			expect(exported.key1).toBeDefined();
			expect(exported.key2).toBeDefined();
		});

		it("should not export invalidated entries", () => {
			manager.set("key1", 10);
			manager.set("key2", 20);
			manager.delete("key1");

			const exported = manager.exportExpirations();

			expect(Object.keys(exported)).toHaveLength(1);
			expect(exported.key1).toBeUndefined();
			expect(exported.key2).toBeDefined();
		});

		it("should return empty object when no TTLs set", () => {
			const exported = manager.exportExpirations();
			expect(exported).toEqual({});
		});
	});

	describe("importExpirations", () => {
		it("should import expirations and rebuild state", () => {
			const now = Date.now();
			const data = {
				key1: now + 10000,
				key2: now + 20000,
			};

			manager.importExpirations(data);

			expect(manager.getTTL("key1")).toBeGreaterThan(0);
			expect(manager.getTTL("key1")).toBeLessThanOrEqual(10);
			expect(manager.getTTL("key2")).toBeGreaterThan(0);
			expect(manager.getTTL("key2")).toBeLessThanOrEqual(20);
		});

		it("should clear previous state on import", () => {
			manager.set("oldKey", 10);

			const now = Date.now();
			manager.importExpirations({ newKey: now + 5000 });

			expect(manager.getTTL("oldKey")).toBe(-1);
			expect(manager.getTTL("newKey")).toBeGreaterThan(0);
		});

		it("should expire imported keys correctly during sweep", () => {
			const now = Date.now();
			manager.importExpirations({
				key1: now + 1000, // expires in 1s
				key2: now + 5000, // expires in 5s
			});

			vi.advanceTimersByTime(1500);

			expect(expiredKeys).toContain("key1");
			expect(expiredKeys).not.toContain("key2");
		});

		it("should handle round-trip export/import", () => {
			manager.set("key1", 10);
			manager.set("key2", 20);

			const exported = manager.exportExpirations();

			// Create a new manager and import
			const newManager = new HeapTTLManager(onExpire, 500);
			newManager.importExpirations(exported);

			expect(newManager.getTTL("key1")).toBeGreaterThan(0);
			expect(newManager.getTTL("key2")).toBeGreaterThan(0);

			newManager.stopSweep();
		});
	});

	describe("stopSweep", () => {
		it("should stop the sweep timer", () => {
			manager.set("key1", 1);
			manager.stopSweep();

			vi.advanceTimersByTime(5000);

			// Key should not be expired because sweep is stopped
			expect(expiredKeys).not.toContain("key1");
		});
	});
});
