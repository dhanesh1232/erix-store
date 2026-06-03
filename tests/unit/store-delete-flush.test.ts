/**
 * @file store-delete-flush.test.ts
 *
 * Unit tests for {@link ErixStore.deleteKey} and {@link ErixStore.flushTenant}
 * — the type-aware delete primitives used by DEL and FLUSHDB.
 *
 * The previous DEL implementation hard-coded a switch on every type. Routing
 * those deletes through `deleteKey` keeps the type registry, the TTL heap,
 * and the underlying sub-stores in sync with one call.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ErixStore } from "../../src/core/Store.js";

describe("ErixStore.deleteKey", () => {
	let store: ErixStore;
	afterEach(() => store.ttlManager.stopSweep());

	it("returns false for a key that doesn't exist", () => {
		store = new ErixStore();
		expect(store.deleteKey("missing")).toBe(false);
	});

	it("deletes a string key, registry entry, and TTL together", () => {
		store = new ErixStore();
		store.reserveKey("k", "string");
		store.strings.set("k", "v");
		store.ttlManager.set("k", 60);

		expect(store.deleteKey("k")).toBe(true);
		expect(store.strings.get("k")).toBe(null);
		expect(store.types.getType("k")).toBe(null);
		expect(store.ttlManager.getTTL("k")).toBe(-1);
	});

	it("deletes a hash key", () => {
		store = new ErixStore();
		store.reserveKey("h", "hash");
		store.hashes.hset("h", "f", "v");

		expect(store.deleteKey("h")).toBe(true);
		expect(store.hashes.hgetall("h")).toBe(null);
		expect(store.types.getType("h")).toBe(null);
	});

	it("deletes a list key", () => {
		store = new ErixStore();
		store.reserveKey("l", "list");
		store.lists.rpush("l", "v");

		expect(store.deleteKey("l")).toBe(true);
		expect(store.lists.has("l")).toBe(false);
		expect(store.types.getType("l")).toBe(null);
	});

	it("deletes a set key", () => {
		store = new ErixStore();
		store.reserveKey("s", "set");
		store.sets.sadd("s", "v");

		expect(store.deleteKey("s")).toBe(true);
		expect(store.sets.smembers("s")).toEqual([]);
		expect(store.types.getType("s")).toBe(null);
	});

	it("deletes a zset key", () => {
		store = new ErixStore();
		store.reserveKey("z", "zset");
		store.sortedSets.zadd("z", 1, "v");

		expect(store.deleteKey("z")).toBe(true);
		expect(store.sortedSets.zrange("z", 0, -1)).toEqual([]);
		expect(store.types.getType("z")).toBe(null);
	});

	it("clears any stale TTL even when the type registry is empty", () => {
		// Belt-and-suspenders: a TTL might survive if a previous code path
		// forgot to call delete. deleteKey should clean it up regardless.
		store = new ErixStore();
		store.ttlManager.set("orphan", 60);
		expect(store.deleteKey("orphan")).toBe(false);
		expect(store.ttlManager.getTTL("orphan")).toBe(-1);
	});
});

describe("ErixStore.flushTenant", () => {
	let store: ErixStore;
	afterEach(() => store.ttlManager.stopSweep());

	it("returns 0 when the tenant has no keys", () => {
		store = new ErixStore();
		expect(store.flushTenant("ghost")).toBe(0);
	});

	it("removes every key inside the tenant prefix", () => {
		store = new ErixStore();
		store.reserveKey("alice:a", "string");
		store.reserveKey("alice:b", "list");
		store.reserveKey("bob:c", "string");

		expect(store.flushTenant("alice")).toBe(2);
		expect(store.types.getType("alice:a")).toBe(null);
		expect(store.types.getType("alice:b")).toBe(null);
		// Bob's data must survive
		expect(store.types.getType("bob:c")).toBe("string");
	});

	it("does not match prefixes that share a common segment", () => {
		// `alice:` is a real boundary — flushing tenant `ali` must not
		// touch `alice`'s keys.
		store = new ErixStore();
		store.reserveKey("alice:a", "string");
		store.reserveKey("ali:b", "string");

		expect(store.flushTenant("ali")).toBe(1);
		expect(store.types.getType("alice:a")).toBe("string");
		expect(store.types.getType("ali:b")).toBe(null);
	});
});

describe("HeapTTLManager.persist", () => {
	it("returns false when the key has no TTL", () => {
		const store = new ErixStore();
		expect(store.ttlManager.persist("nope")).toBe(false);
		store.ttlManager.stopSweep();
	});

	it("returns true and clears the TTL when one was set", () => {
		const store = new ErixStore();
		store.ttlManager.set("k", 60);
		expect(store.ttlManager.getTTL("k")).toBeGreaterThan(0);

		expect(store.ttlManager.persist("k")).toBe(true);
		expect(store.ttlManager.getTTL("k")).toBe(-1);

		store.ttlManager.stopSweep();
	});
});
