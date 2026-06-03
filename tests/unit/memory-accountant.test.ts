/**
 * @file memory-accountant.test.ts
 *
 * Unit tests for the MemoryAccountant + ErixStore eviction integration.
 *
 * What we're locking down:
 *
 *   1. With the cap disabled (default), writes never throw and the
 *      accountant just tracks bytes.
 *   2. With `noeviction` and a tight cap, the next write that would push
 *      the accountant past the cap throws OOMError. Existing data stays
 *      intact — no partial corruption.
 *   3. With `allkeys-lru`, the LRU tail is evicted to make room. Reads
 *      reorder the LRU list — touching a key keeps it alive.
 *   4. With `volatile-lru`, only TTL'd keys are eligible. If every LRU
 *      candidate is permanent, the policy throws OOM (Redis behaviour).
 *   5. Accounting stays sane across delete and import — no negative
 *      `usedBytes`, and snapshot import bypasses the cap (forceCharge).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OOMError } from "../../src/core/errors.js";
import {
	type EvictionPolicy,
	MemoryAccountant,
} from "../../src/core/MemoryAccountant.js";
import { ErixStore } from "../../src/core/Store.js";

describe("MemoryAccountant (standalone)", () => {
	it("tracks usedBytes when cap is disabled and never throws", () => {
		const a = new MemoryAccountant({ maxBytes: 0 });
		a.tryCharge(100);
		a.tryCharge(50);
		expect(a.usedBytes).toBe(150);
	});

	it("throws OOMError when noeviction and cap exceeded", () => {
		const a = new MemoryAccountant({ maxBytes: 100, policy: "noeviction" });
		a.bind(
			() => {},
			() => false,
		);
		a.tryCharge(80);
		expect(() => a.tryCharge(50)).toThrow(OOMError);
		// Failed charges must not have moved usedBytes.
		expect(a.usedBytes).toBe(80);
	});

	it("credit clamps usedBytes at zero (no negative drift)", () => {
		const a = new MemoryAccountant({ maxBytes: 0 });
		a.tryCharge(50);
		a.credit(1000); // way too many bytes
		expect(a.usedBytes).toBe(0);
	});

	it("forceCharge bypasses the cap (used for snapshot import)", () => {
		const a = new MemoryAccountant({ maxBytes: 10, policy: "noeviction" });
		a.bind(
			() => {},
			() => false,
		);
		a.forceCharge(1000);
		expect(a.usedBytes).toBe(1000);
	});
});

describe("ErixStore eviction policies", () => {
	let store: ErixStore;

	afterEach(() => store.ttlManager.stopSweep());

	const buildStore = (opts: { maxBytes: number; policy: EvictionPolicy }) => {
		store = new ErixStore({ memory: opts });
		return store;
	};

	describe("noeviction", () => {
		it("refuses writes that would exceed the cap and keeps existing data intact", () => {
			// Cap is large enough for 'a' but not for both 'a' and 'b' with
			// their byte costs. Exact bytes don't need to be predicted —
			// we just need a cap that's tight enough to fail the second write.
			buildStore({ maxBytes: 200, policy: "noeviction" });
			store.reserveKey("a", "string");
			store.strings.set("a", "hello");

			// Force the cap below current usage so the next write must trip.
			store.accountant.setMaxBytes(store.accountant.usedBytes + 5);

			expect(() => {
				store.reserveKey("b", "string");
				store.strings.set("b", "world!");
			}).toThrow(OOMError);

			// 'a' is still there.
			expect(store.strings.get("a")).toBe("hello");
			// 'b' may have been registered by reserveKey before the throw.
			// Either way, the value must NOT have been written.
			expect(store.strings.get("b")).toBe(null);
		});
	});

	describe("allkeys-lru", () => {
		it("evicts the LRU key when a write would exceed the cap", () => {
			buildStore({ maxBytes: 1_000_000, policy: "allkeys-lru" });
			store.reserveKey("oldest", "string");
			store.strings.set("oldest", "x");
			store.reserveKey("middle", "string");
			store.strings.set("middle", "y");
			store.reserveKey("newest", "string");
			store.strings.set("newest", "z");

			// Tighten the cap so any further write must evict.
			store.accountant.setMaxBytes(store.accountant.usedBytes + 1);

			store.reserveKey("forced", "string");
			store.strings.set("forced", "w");

			// 'oldest' must be gone.
			expect(store.strings.get("oldest")).toBe(null);
			// The LRU touch on read keeps these alive.
			expect(store.strings.get("middle")).toBe("y");
			expect(store.strings.get("newest")).toBe("z");
			expect(store.strings.get("forced")).toBe("w");
			expect(store.accountant.evictedKeys).toBeGreaterThanOrEqual(1);
		});

		it("a read on the LRU key promotes it; the next victim shifts", () => {
			buildStore({ maxBytes: 1_000_000, policy: "allkeys-lru" });
			store.reserveKey("a", "string");
			store.strings.set("a", "1");
			store.reserveKey("b", "string");
			store.strings.set("b", "2");

			// Touch 'a' → 'a' becomes MRU; 'b' is now LRU.
			expect(store.strings.get("a")).toBe("1");

			// Tighten cap; force one eviction.
			store.accountant.setMaxBytes(store.accountant.usedBytes + 1);
			store.reserveKey("c", "string");
			store.strings.set("c", "3");

			expect(store.strings.get("b")).toBe(null);
			expect(store.strings.get("a")).toBe("1");
			expect(store.strings.get("c")).toBe("3");
		});
	});

	describe("volatile-lru", () => {
		it("only evicts keys with a TTL", () => {
			buildStore({ maxBytes: 1_000_000, policy: "volatile-lru" });
			// Permanent key — must NOT be evicted.
			store.reserveKey("permanent", "string");
			store.strings.set("permanent", "keep me");

			// TTL'd keys — eligible for eviction.
			store.reserveKey("expiring-1", "string");
			store.strings.set("expiring-1", "x");
			store.ttlManager.set("expiring-1", 60);

			store.reserveKey("expiring-2", "string");
			store.strings.set("expiring-2", "y");
			store.ttlManager.set("expiring-2", 60);

			// Force eviction by tightening the cap.
			store.accountant.setMaxBytes(store.accountant.usedBytes + 1);
			store.reserveKey("forced", "string");
			store.strings.set("forced", "z");

			// The permanent key must survive.
			expect(store.strings.get("permanent")).toBe("keep me");
			// At least one TTL'd key must be gone.
			const survivors = [
				store.strings.get("expiring-1"),
				store.strings.get("expiring-2"),
			].filter((v) => v !== null).length;
			expect(survivors).toBeLessThanOrEqual(1);
		});

		it("throws OOM when every LRU candidate is permanent", () => {
			buildStore({ maxBytes: 1_000_000, policy: "volatile-lru" });
			store.reserveKey("a", "string");
			store.strings.set("a", "x");
			store.reserveKey("b", "string");
			store.strings.set("b", "y");

			store.accountant.setMaxBytes(store.accountant.usedBytes + 1);

			expect(() => {
				store.reserveKey("c", "string");
				store.strings.set("c", "z");
			}).toThrow(OOMError);
		});
	});

	describe("integration with type registry", () => {
		it("DEL removes the key from the LRU index", () => {
			buildStore({ maxBytes: 1_000_000, policy: "allkeys-lru" });
			store.reserveKey("a", "string");
			store.strings.set("a", "x");
			const before = store.accountant.usedBytes;
			store.deleteKey("a");
			// After DEL, the bytes for 'a' must be credited back.
			expect(store.accountant.usedBytes).toBeLessThan(before);
		});

		it("snapshot import rebuilds the LRU index and used_memory", () => {
			buildStore({ maxBytes: 1_000_000, policy: "allkeys-lru" });
			store.reserveKey("a", "string");
			store.strings.set("a", "x");
			store.reserveKey("b", "string");
			store.strings.set("b", "y");

			const snapshot = store.exportAll();

			const restored = new ErixStore({
				memory: { maxBytes: 1_000_000, policy: "allkeys-lru" },
			});
			restored.importAll(snapshot);
			expect(restored.accountant.usedBytes).toBeGreaterThan(0);
			expect(restored.types.getType("a")).toBe("string");
			expect(restored.types.getType("b")).toBe("string");
			restored.ttlManager.stopSweep();
		});

		it("snapshot import bypasses the cap (forceCharge path)", () => {
			const restored = new ErixStore({
				memory: { maxBytes: 10, policy: "noeviction" }, // tiny cap
			});
			// Build a snapshot that's bigger than the cap, then import.
			restored.importAll({
				strings: { a: "this string is longer than the cap" },
				types: { a: "string" },
			});
			// Restore must succeed and the key must be present, even though
			// the bytes exceed maxmemory. Operators can fix the discrepancy
			// at the next write (which will trigger a normal OOM/eviction).
			expect(restored.strings.get("a")).toBe(
				"this string is longer than the cap",
			);
			restored.ttlManager.stopSweep();
		});
	});
});
