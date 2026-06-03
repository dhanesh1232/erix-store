/**
 * @file doubly-linked-list.test.ts
 *
 * Unit tests for the generic DoublyLinkedList — the O(1) push/pop primitive
 * that backs ListStore.
 */

import { describe, expect, it } from "vitest";
import { DoublyLinkedList } from "../../src/structures/DoublyLinkedList.js";

describe("DoublyLinkedList", () => {
	describe("push / pop", () => {
		it("starts empty", () => {
			const list = new DoublyLinkedList<number>();
			expect(list.length).toBe(0);
			expect(list.popHead()).toBe(null);
			expect(list.popTail()).toBe(null);
		});

		it("pushHead returns the new length", () => {
			const list = new DoublyLinkedList<number>();
			expect(list.pushHead(1)).toBe(1);
			expect(list.pushHead(2)).toBe(2);
			expect(list.pushHead(3)).toBe(3);
			expect(list.toArray()).toEqual([3, 2, 1]);
		});

		it("pushTail returns the new length", () => {
			const list = new DoublyLinkedList<number>();
			expect(list.pushTail(1)).toBe(1);
			expect(list.pushTail(2)).toBe(2);
			expect(list.pushTail(3)).toBe(3);
			expect(list.toArray()).toEqual([1, 2, 3]);
		});

		it("popHead is FIFO with pushTail", () => {
			const list = new DoublyLinkedList<number>();
			list.pushTail(1);
			list.pushTail(2);
			list.pushTail(3);
			expect(list.popHead()).toBe(1);
			expect(list.popHead()).toBe(2);
			expect(list.popHead()).toBe(3);
			expect(list.popHead()).toBe(null);
			expect(list.length).toBe(0);
		});

		it("popTail is LIFO with pushTail", () => {
			const list = new DoublyLinkedList<number>();
			list.pushTail(1);
			list.pushTail(2);
			list.pushTail(3);
			expect(list.popTail()).toBe(3);
			expect(list.popTail()).toBe(2);
			expect(list.popTail()).toBe(1);
			expect(list.popTail()).toBe(null);
		});

		it("interleaves push/pop on both ends correctly", () => {
			const list = new DoublyLinkedList<number>();
			list.pushHead(1); // [1]
			list.pushTail(2); // [1, 2]
			list.pushHead(0); // [0, 1, 2]
			list.pushTail(3); // [0, 1, 2, 3]
			expect(list.toArray()).toEqual([0, 1, 2, 3]);
			expect(list.popHead()).toBe(0);
			expect(list.popTail()).toBe(3);
			expect(list.toArray()).toEqual([1, 2]);
		});

		it("maintains invariants when emptied via popHead", () => {
			const list = new DoublyLinkedList<number>();
			list.pushTail(1);
			list.popHead();
			expect(list.length).toBe(0);
			// Push again — must work after going to zero
			list.pushTail(99);
			expect(list.toArray()).toEqual([99]);
		});

		it("maintains invariants when emptied via popTail", () => {
			const list = new DoublyLinkedList<number>();
			list.pushHead(1);
			list.popTail();
			expect(list.length).toBe(0);
			list.pushHead(99);
			expect(list.toArray()).toEqual([99]);
		});
	});

	describe("index", () => {
		it("returns null for missing or out-of-range indices", () => {
			const list = new DoublyLinkedList<number>();
			expect(list.index(0)).toBe(null);
			list.pushTail(10);
			expect(list.index(1)).toBe(null);
			expect(list.index(-2)).toBe(null);
		});

		it("returns the element at a positive index", () => {
			const list = new DoublyLinkedList<number>();
			[10, 20, 30, 40, 50].forEach((v) => list.pushTail(v));
			expect(list.index(0)).toBe(10);
			expect(list.index(2)).toBe(30);
			expect(list.index(4)).toBe(50);
		});

		it("supports negative indices counted from the tail", () => {
			const list = new DoublyLinkedList<number>();
			[10, 20, 30, 40, 50].forEach((v) => list.pushTail(v));
			expect(list.index(-1)).toBe(50);
			expect(list.index(-3)).toBe(30);
			expect(list.index(-5)).toBe(10);
		});
	});

	describe("range", () => {
		it("returns empty for an empty list", () => {
			const list = new DoublyLinkedList<number>();
			expect(list.range(0, 10)).toEqual([]);
		});

		it("returns the full list for [0, -1]", () => {
			const list = new DoublyLinkedList<number>();
			[1, 2, 3].forEach((v) => list.pushTail(v));
			expect(list.range(0, -1)).toEqual([1, 2, 3]);
		});

		it("clamps out-of-range indices", () => {
			const list = new DoublyLinkedList<number>();
			[1, 2, 3].forEach((v) => list.pushTail(v));
			expect(list.range(0, 999)).toEqual([1, 2, 3]);
			expect(list.range(-999, 1)).toEqual([1, 2]);
		});

		it("returns empty when start > stop after normalization", () => {
			const list = new DoublyLinkedList<number>();
			[1, 2, 3].forEach((v) => list.pushTail(v));
			expect(list.range(2, 1)).toEqual([]);
			expect(list.range(-1, -2)).toEqual([]);
		});

		it("supports a slice in the middle", () => {
			const list = new DoublyLinkedList<number>();
			[10, 20, 30, 40, 50].forEach((v) => list.pushTail(v));
			expect(list.range(1, 3)).toEqual([20, 30, 40]);
			expect(list.range(-3, -1)).toEqual([30, 40, 50]);
		});
	});

	describe("remove", () => {
		const seed = () => {
			const list = new DoublyLinkedList<number>();
			[1, 2, 3, 2, 1, 2].forEach((v) => list.pushTail(v));
			return list;
		};

		it("count > 0 removes from head", () => {
			const list = seed();
			expect(list.remove((v) => v === 2, 2)).toBe(2);
			expect(list.toArray()).toEqual([1, 3, 1, 2]);
		});

		it("count < 0 removes from tail", () => {
			const list = seed();
			expect(list.remove((v) => v === 2, -2)).toBe(2);
			expect(list.toArray()).toEqual([1, 2, 3, 1]);
		});

		it("count = 0 removes all matches", () => {
			const list = seed();
			expect(list.remove((v) => v === 2, 0)).toBe(3);
			expect(list.toArray()).toEqual([1, 3, 1]);
		});

		it("returns 0 when nothing matches", () => {
			const list = seed();
			expect(list.remove((v) => v === 999, 0)).toBe(0);
			expect(list.toArray()).toEqual([1, 2, 3, 2, 1, 2]);
		});

		it("can drain the list completely", () => {
			const list = new DoublyLinkedList<number>();
			[5, 5, 5].forEach((v) => list.pushTail(v));
			expect(list.remove((v) => v === 5, 0)).toBe(3);
			expect(list.length).toBe(0);
			expect(list.popHead()).toBe(null);
		});
	});

	describe("trim", () => {
		const seed = () => {
			const list = new DoublyLinkedList<number>();
			[10, 20, 30, 40, 50].forEach((v) => list.pushTail(v));
			return list;
		};

		it("keeps a middle slice", () => {
			const list = seed();
			list.trim(1, 3);
			expect(list.toArray()).toEqual([20, 30, 40]);
		});

		it("supports negative indices", () => {
			const list = seed();
			list.trim(-3, -1);
			expect(list.toArray()).toEqual([30, 40, 50]);
		});

		it("clamps out-of-range indices", () => {
			const list = seed();
			list.trim(0, 999);
			expect(list.toArray()).toEqual([10, 20, 30, 40, 50]);
		});

		it("empties the list when the range is invalid", () => {
			const list = seed();
			list.trim(99, 100);
			expect(list.length).toBe(0);
		});

		it("empties the list when start > stop", () => {
			const list = seed();
			list.trim(3, 1);
			expect(list.length).toBe(0);
		});
	});

	describe("clear", () => {
		it("drops all elements", () => {
			const list = new DoublyLinkedList<number>();
			[1, 2, 3].forEach((v) => list.pushTail(v));
			list.clear();
			expect(list.length).toBe(0);
			expect(list.popHead()).toBe(null);
		});
	});

	describe("Symbol.iterator", () => {
		it("iterates head → tail", () => {
			const list = new DoublyLinkedList<number>();
			[1, 2, 3].forEach((v) => list.pushTail(v));
			expect([...list]).toEqual([1, 2, 3]);
		});
	});

	describe("performance characteristics", () => {
		// Sanity check: 100k pushHeads + 100k popHeads finishes quickly.
		// The previous Array-based implementation would be O(n^2) here.
		it("handles 100k pushHead/popHead without blowing the time budget", () => {
			const list = new DoublyLinkedList<number>();
			const n = 100_000;
			const start = Date.now();
			for (let i = 0; i < n; i++) list.pushHead(i);
			for (let i = 0; i < n; i++) list.popHead();
			const elapsed = Date.now() - start;
			// 1 second is several orders of magnitude more than this should take;
			// we only fail if we accidentally regress to O(n^2).
			expect(elapsed).toBeLessThan(1000);
			expect(list.length).toBe(0);
		});
	});
});
