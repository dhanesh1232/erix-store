/**
 * @file store-reserve-key.test.ts
 *
 * Tests the {@link ErixStore.reserveKey} contract:
 *
 *   1. Live, registered as the same type   → no-op.
 *   2. Live, registered as a different type → throws WrongTypeError.
 *   3. Unregistered                          → registers as the requested type.
 *   4. Expired but not yet swept            → lazy-expires (deletes from the
 *      old store, unregisters the old type), then registers as the new type.
 *
 * The fourth case is the whole point of the helper — it removes the race
 * between TTL expiry and a follow-up SET that wants to take over the key
 * with a different data type.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WrongTypeError } from "../../src/core/errors.js";
import { ErixStore } from "../../src/core/Store.js";

describe("ErixStore.reserveKey", () => {
	let store: ErixStore;

	beforeEach(() => {
		vi.useFakeTimers();
		store = new ErixStore();
	});

	afterEach(() => {
		store.ttlManager.stopSweep();
		vi.useRealTimers();
	});

	it("registers an unknown key under the requested type", () => {
		store.reserveKey("k", "string");
		expect(store.types.getType("k")).toBe("string");
	});

	it("is a no-op when the key is already registered as the same type", () => {
		store.reserveKey("k", "string");
		expect(() => store.reserveKey("k", "string")).not.toThrow();
		expect(store.types.getType("k")).toBe("string");
	});

	it("throws WrongTypeError when the live key is a different type", () => {
		store.reserveKey("k", "string");
		expect(() => store.reserveKey("k", "list")).toThrow(WrongTypeError);
	});

	it("lazy-expires an expired-but-not-swept key, then registers the new type", () => {
		// Set up: a string key with a 1-second TTL.
		store.reserveKey("k", "string");
		store.strings.set("k", "old");
		store.ttlManager.set("k", 1);

		// Advance 1.5s — the TTL has elapsed but no sweep has fired yet
		// because we're using fake timers without advancing the interval
		// callback. Stop the sweep loop so the lazy path is exercised.
		store.ttlManager.stopSweep();
		vi.setSystemTime(Date.now() + 1500);

		// reserveKey must lazy-expire the stale string and accept the new
		// list registration without WRONGTYPE.
		expect(() => store.reserveKey("k", "list")).not.toThrow();
		expect(store.types.getType("k")).toBe("list");
		// Old value is gone.
		expect(store.strings.get("k")).toBe(null);
	});

	it("does not lazy-expire keys without a TTL", () => {
		// Permanent string key
		store.reserveKey("k", "string");
		store.strings.set("k", "permanent");

		// Time passes — no TTL, no expiry.
		vi.setSystemTime(Date.now() + 3_600_000);

		expect(() => store.reserveKey("k", "list")).toThrow(WrongTypeError);
		expect(store.strings.get("k")).toBe("permanent");
	});
});

describe("HeapTTLManager default sweep interval", () => {
	it("defaults to 100ms — keys with sub-second TTL are reaped on the active sweep", () => {
		vi.useFakeTimers();
		const store = new ErixStore();

		store.reserveKey("k", "string");
		store.strings.set("k", "v");
		store.ttlManager.set("k", 1); // 1 second

		// Advance past expiry plus one sweep tick (default 100 ms).
		vi.advanceTimersByTime(1100);

		expect(store.types.getType("k")).toBe(null);
		expect(store.strings.get("k")).toBe(null);

		store.ttlManager.stopSweep();
		vi.useRealTimers();
	});
});
