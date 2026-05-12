import { beforeEach, describe, expect, it } from "vitest";
import { SortedSetStore } from "../../src/structures/SortedSet.js";

describe("SortedSetStore (SkipList-based)", () => {
	let store: SortedSetStore;

	beforeEach(() => {
		store = new SortedSetStore();
	});

	describe("zadd", () => {
		it("returns 1 when adding a new member", () => {
			expect(store.zadd("myset", 1.0, "alice")).toBe(1);
		});

		it("returns 0 when updating an existing member", () => {
			store.zadd("myset", 1.0, "alice");
			expect(store.zadd("myset", 2.0, "alice")).toBe(0);
		});

		it("maintains score order", () => {
			store.zadd("myset", 3.0, "charlie");
			store.zadd("myset", 1.0, "alice");
			store.zadd("myset", 2.0, "bob");
			expect(store.zrange("myset", 0, -1)).toEqual(["alice", "bob", "charlie"]);
		});

		it("updates score and re-orders correctly", () => {
			store.zadd("myset", 1.0, "alice");
			store.zadd("myset", 2.0, "bob");
			store.zadd("myset", 3.0, "charlie");
			// Move alice to the end
			store.zadd("myset", 10.0, "alice");
			expect(store.zrange("myset", 0, -1)).toEqual(["bob", "charlie", "alice"]);
		});

		it("handles equal scores with lexicographic ordering", () => {
			store.zadd("myset", 1.0, "banana");
			store.zadd("myset", 1.0, "apple");
			store.zadd("myset", 1.0, "cherry");
			expect(store.zrange("myset", 0, -1)).toEqual([
				"apple",
				"banana",
				"cherry",
			]);
		});
	});

	describe("zrange", () => {
		beforeEach(() => {
			store.zadd("myset", 1.0, "a");
			store.zadd("myset", 2.0, "b");
			store.zadd("myset", 3.0, "c");
			store.zadd("myset", 4.0, "d");
			store.zadd("myset", 5.0, "e");
		});

		it("returns elements in the given range", () => {
			expect(store.zrange("myset", 0, 2)).toEqual(["a", "b", "c"]);
		});

		it("supports negative indices", () => {
			expect(store.zrange("myset", -3, -1)).toEqual(["c", "d", "e"]);
		});

		it("returns all elements with 0 to -1", () => {
			expect(store.zrange("myset", 0, -1)).toEqual(["a", "b", "c", "d", "e"]);
		});

		it("returns empty array for non-existent key", () => {
			expect(store.zrange("nokey", 0, -1)).toEqual([]);
		});

		it("returns empty array for out-of-range indices", () => {
			expect(store.zrange("myset", 10, 20)).toEqual([]);
		});
	});

	describe("zscore", () => {
		it("returns the score of an existing member", () => {
			store.zadd("myset", 3.14, "pi");
			expect(store.zscore("myset", "pi")).toBe(3.14);
		});

		it("returns null for non-existent member", () => {
			store.zadd("myset", 1.0, "alice");
			expect(store.zscore("myset", "bob")).toBeNull();
		});

		it("returns null for non-existent key", () => {
			expect(store.zscore("nokey", "alice")).toBeNull();
		});

		it("returns updated score after zadd update", () => {
			store.zadd("myset", 1.0, "alice");
			store.zadd("myset", 5.0, "alice");
			expect(store.zscore("myset", "alice")).toBe(5.0);
		});
	});

	describe("zrem", () => {
		it("returns 1 when removing an existing member", () => {
			store.zadd("myset", 1.0, "alice");
			expect(store.zrem("myset", "alice")).toBe(1);
		});

		it("returns 0 when removing a non-existent member", () => {
			store.zadd("myset", 1.0, "alice");
			expect(store.zrem("myset", "bob")).toBe(0);
		});

		it("returns 0 for non-existent key", () => {
			expect(store.zrem("nokey", "alice")).toBe(0);
		});

		it("removes the member from the set", () => {
			store.zadd("myset", 1.0, "alice");
			store.zadd("myset", 2.0, "bob");
			store.zrem("myset", "alice");
			expect(store.zrange("myset", 0, -1)).toEqual(["bob"]);
			expect(store.zscore("myset", "alice")).toBeNull();
		});

		it("cleans up empty sets", () => {
			store.zadd("myset", 1.0, "alice");
			store.zrem("myset", "alice");
			expect(store.zrange("myset", 0, -1)).toEqual([]);
		});
	});

	describe("delete", () => {
		it("removes the entire key", () => {
			store.zadd("myset", 1.0, "alice");
			store.zadd("myset", 2.0, "bob");
			store.delete("myset");
			expect(store.zrange("myset", 0, -1)).toEqual([]);
			expect(store.zscore("myset", "alice")).toBeNull();
		});
	});

	describe("export/import", () => {
		it("exports all data as Record<string, SortedSetMember[]>", () => {
			store.zadd("set1", 1.0, "a");
			store.zadd("set1", 2.0, "b");
			store.zadd("set2", 3.0, "c");

			const exported = store.export();
			expect(exported).toEqual({
				set1: [
					{ value: "a", score: 1.0 },
					{ value: "b", score: 2.0 },
				],
				set2: [{ value: "c", score: 3.0 }],
			});
		});

		it("imports data and restores state correctly", () => {
			const data = {
				set1: [
					{ value: "x", score: 10 },
					{ value: "y", score: 20 },
				],
				set2: [{ value: "z", score: 5 }],
			};

			store.import(data);

			expect(store.zrange("set1", 0, -1)).toEqual(["x", "y"]);
			expect(store.zscore("set1", "x")).toBe(10);
			expect(store.zscore("set1", "y")).toBe(20);
			expect(store.zrange("set2", 0, -1)).toEqual(["z"]);
			expect(store.zscore("set2", "z")).toBe(5);
		});

		it("import clears previous state", () => {
			store.zadd("old", 1.0, "stale");
			store.import({ new: [{ value: "fresh", score: 1.0 }] });
			expect(store.zrange("old", 0, -1)).toEqual([]);
			expect(store.zrange("new", 0, -1)).toEqual(["fresh"]);
		});

		it("round-trip export/import preserves all data", () => {
			store.zadd("myset", 1.5, "alpha");
			store.zadd("myset", 2.5, "beta");
			store.zadd("myset", 0.5, "gamma");

			const exported = store.export();
			const newStore = new SortedSetStore();
			newStore.import(exported);

			expect(newStore.zrange("myset", 0, -1)).toEqual([
				"gamma",
				"alpha",
				"beta",
			]);
			expect(newStore.zscore("myset", "alpha")).toBe(1.5);
			expect(newStore.zscore("myset", "beta")).toBe(2.5);
			expect(newStore.zscore("myset", "gamma")).toBe(0.5);
		});
	});
});
