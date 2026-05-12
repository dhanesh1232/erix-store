import { describe, expect, it } from "vitest";
import { SkipList } from "../../src/structures/SkipList.js";

describe("SkipList", () => {
	const numCompare = (a: number, b: number) => a - b;
	const strCompare = (a: string, b: string) => a.localeCompare(b);

	describe("set and get", () => {
		it("should insert and retrieve a single element", () => {
			const sl = new SkipList<number, string>(numCompare);
			const isNew = sl.set(5, "five");
			expect(isNew).toBe(true);
			expect(sl.get(5)).toBe("five");
		});

		it("should return true for new keys and false for updates", () => {
			const sl = new SkipList<number, string>(numCompare);
			expect(sl.set(1, "one")).toBe(true);
			expect(sl.set(1, "ONE")).toBe(false);
			expect(sl.get(1)).toBe("ONE");
		});

		it("should return undefined for missing keys", () => {
			const sl = new SkipList<number, string>(numCompare);
			expect(sl.get(42)).toBeUndefined();
		});

		it("should handle multiple insertions", () => {
			const sl = new SkipList<number, string>(numCompare);
			sl.set(3, "three");
			sl.set(1, "one");
			sl.set(5, "five");
			sl.set(2, "two");
			sl.set(4, "four");

			expect(sl.get(1)).toBe("one");
			expect(sl.get(2)).toBe("two");
			expect(sl.get(3)).toBe("three");
			expect(sl.get(4)).toBe("four");
			expect(sl.get(5)).toBe("five");
		});

		it("should work with string keys", () => {
			const sl = new SkipList<string, number>(strCompare);
			sl.set("banana", 2);
			sl.set("apple", 1);
			sl.set("cherry", 3);

			expect(sl.get("apple")).toBe(1);
			expect(sl.get("banana")).toBe(2);
			expect(sl.get("cherry")).toBe(3);
		});
	});

	describe("delete", () => {
		it("should delete an existing key", () => {
			const sl = new SkipList<number, string>(numCompare);
			sl.set(1, "one");
			sl.set(2, "two");
			sl.set(3, "three");

			expect(sl.delete(2)).toBe(true);
			expect(sl.get(2)).toBeUndefined();
			expect(sl.length).toBe(2);
		});

		it("should return false for non-existent key", () => {
			const sl = new SkipList<number, string>(numCompare);
			sl.set(1, "one");
			expect(sl.delete(99)).toBe(false);
		});

		it("should maintain order after deletion", () => {
			const sl = new SkipList<number, string>(numCompare);
			sl.set(1, "one");
			sl.set(2, "two");
			sl.set(3, "three");
			sl.set(4, "four");
			sl.set(5, "five");

			sl.delete(3);

			const arr = sl.toArray();
			expect(arr.map((e) => e.key)).toEqual([1, 2, 4, 5]);
		});
	});

	describe("length", () => {
		it("should return 0 for empty list", () => {
			const sl = new SkipList<number, string>(numCompare);
			expect(sl.length).toBe(0);
		});

		it("should track insertions and deletions", () => {
			const sl = new SkipList<number, string>(numCompare);
			sl.set(1, "a");
			sl.set(2, "b");
			expect(sl.length).toBe(2);

			sl.set(1, "updated"); // update, not new
			expect(sl.length).toBe(2);

			sl.delete(1);
			expect(sl.length).toBe(1);
		});
	});

	describe("range", () => {
		it("should return elements in the given rank range", () => {
			const sl = new SkipList<number, string>(numCompare);
			sl.set(10, "ten");
			sl.set(20, "twenty");
			sl.set(30, "thirty");
			sl.set(40, "forty");
			sl.set(50, "fifty");

			const result = sl.range(1, 3);
			expect(result).toEqual([
				{ key: 20, value: "twenty" },
				{ key: 30, value: "thirty" },
				{ key: 40, value: "forty" },
			]);
		});

		it("should support negative indices", () => {
			const sl = new SkipList<number, string>(numCompare);
			sl.set(1, "a");
			sl.set(2, "b");
			sl.set(3, "c");
			sl.set(4, "d");

			// -2 to -1 means last two elements
			const result = sl.range(-2, -1);
			expect(result).toEqual([
				{ key: 3, value: "c" },
				{ key: 4, value: "d" },
			]);
		});

		it("should return empty array for out-of-bounds range", () => {
			const sl = new SkipList<number, string>(numCompare);
			sl.set(1, "a");
			sl.set(2, "b");

			expect(sl.range(5, 10)).toEqual([]);
		});

		it("should return empty array for empty list", () => {
			const sl = new SkipList<number, string>(numCompare);
			expect(sl.range(0, 5)).toEqual([]);
		});

		it("should return all elements with range(0, -1)", () => {
			const sl = new SkipList<number, string>(numCompare);
			sl.set(3, "c");
			sl.set(1, "a");
			sl.set(2, "b");

			const result = sl.range(0, -1);
			expect(result).toEqual([
				{ key: 1, value: "a" },
				{ key: 2, value: "b" },
				{ key: 3, value: "c" },
			]);
		});
	});

	describe("toArray", () => {
		it("should return all elements in sorted order", () => {
			const sl = new SkipList<number, string>(numCompare);
			sl.set(5, "five");
			sl.set(1, "one");
			sl.set(3, "three");
			sl.set(2, "two");
			sl.set(4, "four");

			expect(sl.toArray()).toEqual([
				{ key: 1, value: "one" },
				{ key: 2, value: "two" },
				{ key: 3, value: "three" },
				{ key: 4, value: "four" },
				{ key: 5, value: "five" },
			]);
		});

		it("should return empty array for empty list", () => {
			const sl = new SkipList<number, string>(numCompare);
			expect(sl.toArray()).toEqual([]);
		});
	});

	describe("custom comparator", () => {
		it("should support composite key ordering", () => {
			// Simulate sorted set: order by score ASC, then by value ASC
			interface CompositeKey {
				score: number;
				value: string;
			}

			const compositeCompare = (a: CompositeKey, b: CompositeKey): number => {
				if (a.score !== b.score) return a.score - b.score;
				return a.value.localeCompare(b.value);
			};

			const sl = new SkipList<CompositeKey, string>(compositeCompare);
			sl.set({ score: 2, value: "bob" }, "bob");
			sl.set({ score: 1, value: "alice" }, "alice");
			sl.set({ score: 2, value: "adam" }, "adam");
			sl.set({ score: 1, value: "zoe" }, "zoe");

			const arr = sl.toArray();
			expect(arr.map((e) => e.value)).toEqual(["alice", "zoe", "adam", "bob"]);
		});
	});
});
