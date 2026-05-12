import { describe, expect, it } from "vitest";
import { LRUList } from "../../src/structures/LRUList.js";

describe("LRUList", () => {
	describe("add", () => {
		it("should add a key and increase size", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			expect(lru.size).toBe(1);
		});

		it("should not duplicate keys on repeated add", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.add("a");
			expect(lru.size).toBe(1);
		});

		it("should move existing key to head on re-add", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.add("b");
			lru.add("a"); // re-add moves to head
			// Evict should return 'b' (now the tail)
			expect(lru.evict()).toBe("b");
		});
	});

	describe("touch", () => {
		it("should move key to head (most recently used)", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.add("b");
			lru.add("c");
			// Order: c(head) -> b -> a(tail)
			lru.touch("a");
			// Order: a(head) -> c -> b(tail)
			expect(lru.evict()).toBe("b");
		});

		it("should be a no-op for non-existent key", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.touch("nonexistent");
			expect(lru.size).toBe(1);
		});

		it("should be a no-op when key is already at head", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.add("b");
			// b is at head
			lru.touch("b");
			expect(lru.evict()).toBe("a");
		});
	});

	describe("evict", () => {
		it("should return undefined on empty list", () => {
			const lru = new LRUList<string>();
			expect(lru.evict()).toBeUndefined();
		});

		it("should return the least recently used key (tail)", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.add("b");
			lru.add("c");
			// Order: c(head) -> b -> a(tail)
			expect(lru.evict()).toBe("a");
		});

		it("should decrease size after eviction", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.add("b");
			lru.evict();
			expect(lru.size).toBe(1);
		});

		it("should handle evicting all elements", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.add("b");
			expect(lru.evict()).toBe("a");
			expect(lru.evict()).toBe("b");
			expect(lru.evict()).toBeUndefined();
			expect(lru.size).toBe(0);
		});

		it("should handle single element eviction", () => {
			const lru = new LRUList<string>();
			lru.add("only");
			expect(lru.evict()).toBe("only");
			expect(lru.size).toBe(0);
			expect(lru.evict()).toBeUndefined();
		});
	});

	describe("remove", () => {
		it("should remove a specific key", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.add("b");
			lru.add("c");
			lru.remove("b");
			expect(lru.size).toBe(2);
			// Order: c(head) -> a(tail)
			expect(lru.evict()).toBe("a");
			expect(lru.evict()).toBe("c");
		});

		it("should handle removing the head", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.add("b");
			// b is head
			lru.remove("b");
			expect(lru.size).toBe(1);
			expect(lru.evict()).toBe("a");
		});

		it("should handle removing the tail", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.add("b");
			// a is tail
			lru.remove("a");
			expect(lru.size).toBe(1);
			expect(lru.evict()).toBe("b");
		});

		it("should be a no-op for non-existent key", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.remove("nonexistent");
			expect(lru.size).toBe(1);
		});

		it("should handle removing the only element", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.remove("a");
			expect(lru.size).toBe(0);
			expect(lru.evict()).toBeUndefined();
		});
	});

	describe("size", () => {
		it("should return 0 for empty list", () => {
			const lru = new LRUList<string>();
			expect(lru.size).toBe(0);
		});

		it("should track size correctly through operations", () => {
			const lru = new LRUList<string>();
			expect(lru.size).toBe(0);
			lru.add("a");
			expect(lru.size).toBe(1);
			lru.add("b");
			expect(lru.size).toBe(2);
			lru.remove("a");
			expect(lru.size).toBe(1);
			lru.evict();
			expect(lru.size).toBe(0);
		});
	});

	describe("numeric keys", () => {
		it("should work with number keys", () => {
			const lru = new LRUList<number>();
			lru.add(1);
			lru.add(2);
			lru.add(3);
			lru.touch(1);
			expect(lru.evict()).toBe(2);
		});
	});

	describe("complex access patterns", () => {
		it("should maintain correct LRU order through mixed operations", () => {
			const lru = new LRUList<string>();
			lru.add("a");
			lru.add("b");
			lru.add("c");
			lru.add("d");
			// Order: d -> c -> b -> a
			lru.touch("b");
			// Order: b -> d -> c -> a
			lru.touch("a");
			// Order: a -> b -> d -> c
			expect(lru.evict()).toBe("c");
			expect(lru.evict()).toBe("d");
			expect(lru.evict()).toBe("b");
			expect(lru.evict()).toBe("a");
		});
	});
});
