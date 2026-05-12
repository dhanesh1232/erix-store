import { describe, expect, it } from "vitest";
import { BinaryMaxHeap } from "../../src/structures/BinaryHeap.js";

/** Helper to pop and assert non-undefined */
function popOrFail<T>(heap: BinaryMaxHeap<T>): T {
	const value = heap.pop();
	if (value === undefined) throw new Error("Unexpected empty heap");
	return value;
}

describe("BinaryMaxHeap", () => {
	// Simple numeric max-heap comparator
	const maxCompare = (a: number, b: number) => a - b;
	// Simple numeric min-heap comparator
	const minCompare = (a: number, b: number) => b - a;

	describe("push and peek", () => {
		it("should return undefined when peeking an empty heap", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			expect(heap.peek()).toBeUndefined();
		});

		it("should peek the largest element in a max-heap", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			heap.push(3);
			heap.push(7);
			heap.push(1);
			expect(heap.peek()).toBe(7);
		});

		it("should peek the smallest element in a min-heap", () => {
			const heap = new BinaryMaxHeap<number>(minCompare);
			heap.push(3);
			heap.push(7);
			heap.push(1);
			expect(heap.peek()).toBe(1);
		});
	});

	describe("pop", () => {
		it("should return undefined when popping an empty heap", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			expect(heap.pop()).toBeUndefined();
		});

		it("should extract elements in descending order (max-heap)", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			const values = [5, 3, 8, 1, 9, 2, 7, 4, 6];
			for (const v of values) heap.push(v);

			const result: number[] = [];
			while (heap.size > 0) {
				result.push(popOrFail(heap));
			}
			expect(result).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
		});

		it("should extract elements in ascending order (min-heap)", () => {
			const heap = new BinaryMaxHeap<number>(minCompare);
			const values = [5, 3, 8, 1, 9, 2, 7, 4, 6];
			for (const v of values) heap.push(v);

			const result: number[] = [];
			while (heap.size > 0) {
				result.push(popOrFail(heap));
			}
			expect(result).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		});

		it("should handle a single element", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			heap.push(42);
			expect(heap.pop()).toBe(42);
			expect(heap.size).toBe(0);
			expect(heap.pop()).toBeUndefined();
		});
	});

	describe("size", () => {
		it("should start at 0", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			expect(heap.size).toBe(0);
		});

		it("should track insertions and extractions", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			heap.push(1);
			heap.push(2);
			expect(heap.size).toBe(2);
			heap.pop();
			expect(heap.size).toBe(1);
			heap.pop();
			expect(heap.size).toBe(0);
		});
	});

	describe("remove", () => {
		it("should return undefined if predicate matches nothing", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			heap.push(1);
			heap.push(2);
			expect(heap.remove((x) => x === 99)).toBeUndefined();
		});

		it("should remove a specific element by predicate", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			heap.push(5);
			heap.push(3);
			heap.push(8);
			heap.push(1);
			heap.push(9);

			const removed = heap.remove((x) => x === 8);
			expect(removed).toBe(8);
			expect(heap.size).toBe(4);

			// Heap property should still hold
			const result: number[] = [];
			while (heap.size > 0) {
				result.push(popOrFail(heap));
			}
			expect(result).toEqual([9, 5, 3, 1]);
		});

		it("should remove the root element correctly", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			heap.push(5);
			heap.push(3);
			heap.push(8);

			const removed = heap.remove((x) => x === 8);
			expect(removed).toBe(8);
			expect(heap.peek()).toBe(5);
		});

		it("should remove the last element correctly", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			heap.push(5);
			heap.push(3);
			heap.push(8);

			// Remove the element that happens to be last in the array
			// After push(5), push(3), push(8): array is [8, 3, 5]
			const removed = heap.remove((x) => x === 5);
			expect(removed).toBe(5);
			expect(heap.size).toBe(2);

			const result: number[] = [];
			while (heap.size > 0) {
				result.push(popOrFail(heap));
			}
			expect(result).toEqual([8, 3]);
		});
	});

	describe("[Symbol.iterator]", () => {
		it("should iterate all elements (unordered)", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			heap.push(5);
			heap.push(3);
			heap.push(8);
			heap.push(1);

			const elements = [...heap];
			expect(elements.sort((a, b) => a - b)).toEqual([1, 3, 5, 8]);
		});

		it("should return empty iterator for empty heap", () => {
			const heap = new BinaryMaxHeap<number>(maxCompare);
			expect([...heap]).toEqual([]);
		});
	});

	describe("comparator-based usage (job queue scenario)", () => {
		interface Job {
			id: string;
			priority: number;
			createdAt: Date;
		}

		// Higher priority first; on tie, older job first
		const jobCompare = (a: Job, b: Job): number => {
			if (a.priority !== b.priority) return a.priority - b.priority;
			return b.createdAt.getTime() - a.createdAt.getTime();
		};

		it("should return highest priority job first", () => {
			const heap = new BinaryMaxHeap<Job>(jobCompare);
			heap.push({ id: "a", priority: 1, createdAt: new Date("2024-01-01") });
			heap.push({ id: "b", priority: 5, createdAt: new Date("2024-01-02") });
			heap.push({ id: "c", priority: 3, createdAt: new Date("2024-01-03") });

			expect(heap.pop()?.id).toBe("b");
			expect(heap.pop()?.id).toBe("c");
			expect(heap.pop()?.id).toBe("a");
		});

		it("should return older job first on priority tie", () => {
			const heap = new BinaryMaxHeap<Job>(jobCompare);
			heap.push({ id: "new", priority: 5, createdAt: new Date("2024-06-01") });
			heap.push({ id: "old", priority: 5, createdAt: new Date("2024-01-01") });
			heap.push({ id: "mid", priority: 5, createdAt: new Date("2024-03-01") });

			expect(heap.pop()?.id).toBe("old");
			expect(heap.pop()?.id).toBe("mid");
			expect(heap.pop()?.id).toBe("new");
		});
	});

	describe("min-heap usage (TTL scenario)", () => {
		interface TTLEntry {
			key: string;
			expiresAt: number;
		}

		// Min-heap: smallest expiresAt at root
		const ttlCompare = (a: TTLEntry, b: TTLEntry): number =>
			b.expiresAt - a.expiresAt;

		it("should return soonest-expiring entry first", () => {
			const heap = new BinaryMaxHeap<TTLEntry>(ttlCompare);
			heap.push({ key: "later", expiresAt: 5000 });
			heap.push({ key: "soon", expiresAt: 1000 });
			heap.push({ key: "mid", expiresAt: 3000 });

			expect(heap.pop()?.key).toBe("soon");
			expect(heap.pop()?.key).toBe("mid");
			expect(heap.pop()?.key).toBe("later");
		});
	});
});
