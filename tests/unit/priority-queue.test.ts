/**
 * @file priority-queue.test.ts
 *
 * Unit tests for the lightweight Redis-style priority queue.
 *
 * The two invariants worth pinning down:
 *   1. Higher priority dequeues first.
 *   2. Equal-priority entries dequeue in insertion order (FIFO).
 *
 * Plus the boring stuff: empty-queue handling, peek vs dequeue,
 * clear, multi-queue isolation, and snapshot round-trip.
 */

import { describe, expect, it } from "vitest";
import { PriorityQueue } from "../../src/services/PriorityQueue.js";

describe("PriorityQueue", () => {
	describe("basic FIFO at equal priority", () => {
		it("dequeues in insertion order when priorities tie", () => {
			const q = new PriorityQueue();
			q.enqueue("q", "first");
			q.enqueue("q", "second");
			q.enqueue("q", "third");

			expect(q.dequeue("q")).toBe("first");
			expect(q.dequeue("q")).toBe("second");
			expect(q.dequeue("q")).toBe("third");
			expect(q.dequeue("q")).toBe(null);
		});

		it("returns the new length on enqueue", () => {
			const q = new PriorityQueue();
			expect(q.enqueue("q", "a")).toBe(1);
			expect(q.enqueue("q", "b")).toBe(2);
			expect(q.enqueue("q", "c")).toBe(3);
		});
	});

	describe("priority ordering", () => {
		it("higher priority wins regardless of insertion order", () => {
			const q = new PriorityQueue();
			q.enqueue("q", "low", 1);
			q.enqueue("q", "high", 10);
			q.enqueue("q", "mid", 5);

			expect(q.dequeue("q")).toBe("high");
			expect(q.dequeue("q")).toBe("mid");
			expect(q.dequeue("q")).toBe("low");
		});

		it("late high-priority pushes overtake early low-priority ones", () => {
			const q = new PriorityQueue();
			q.enqueue("q", "first-but-low", 0);
			q.enqueue("q", "second-but-high", 100);

			expect(q.dequeue("q")).toBe("second-but-high");
			expect(q.dequeue("q")).toBe("first-but-low");
		});

		it("preserves FIFO within a priority band", () => {
			const q = new PriorityQueue();
			// Interleave priorities; check FIFO holds within each band.
			q.enqueue("q", "h1", 10);
			q.enqueue("q", "l1", 1);
			q.enqueue("q", "h2", 10);
			q.enqueue("q", "l2", 1);
			q.enqueue("q", "h3", 10);

			expect(q.dequeue("q")).toBe("h1");
			expect(q.dequeue("q")).toBe("h2");
			expect(q.dequeue("q")).toBe("h3");
			expect(q.dequeue("q")).toBe("l1");
			expect(q.dequeue("q")).toBe("l2");
		});
	});

	describe("peek / len", () => {
		it("peek returns the next value without removing", () => {
			const q = new PriorityQueue();
			q.enqueue("q", "a", 5);
			q.enqueue("q", "b", 10);

			expect(q.peek("q")).toBe("b");
			expect(q.peek("q")).toBe("b");
			expect(q.len("q")).toBe(2);
		});

		it("peek and len return null/0 for an unknown queue", () => {
			const q = new PriorityQueue();
			expect(q.peek("ghost")).toBe(null);
			expect(q.len("ghost")).toBe(0);
		});

		it("len decreases on each dequeue and goes to zero", () => {
			const q = new PriorityQueue();
			q.enqueue("q", "a");
			q.enqueue("q", "b");
			expect(q.len("q")).toBe(2);
			q.dequeue("q");
			expect(q.len("q")).toBe(1);
			q.dequeue("q");
			expect(q.len("q")).toBe(0);
		});
	});

	describe("clear", () => {
		it("returns the number of entries dropped", () => {
			const q = new PriorityQueue();
			q.enqueue("q", "a");
			q.enqueue("q", "b");
			q.enqueue("q", "c");
			expect(q.clear("q")).toBe(3);
			expect(q.len("q")).toBe(0);
			expect(q.dequeue("q")).toBe(null);
		});

		it("returns 0 for unknown queues", () => {
			expect(new PriorityQueue().clear("ghost")).toBe(0);
		});
	});

	describe("multi-queue isolation", () => {
		it("operations on one queue don't affect another", () => {
			const q = new PriorityQueue();
			q.enqueue("a", "1");
			q.enqueue("b", "2");
			q.enqueue("a", "3");

			expect(q.len("a")).toBe(2);
			expect(q.len("b")).toBe(1);
			expect(q.dequeue("a")).toBe("1");
			expect(q.dequeue("b")).toBe("2");
		});
	});

	describe("export / import", () => {
		it("round-trips state, preserving priority + FIFO order", () => {
			const q = new PriorityQueue();
			q.enqueue("q", "low-1", 1);
			q.enqueue("q", "high-1", 10);
			q.enqueue("q", "low-2", 1);
			q.enqueue("q", "high-2", 10);

			const snapshot = q.export();
			const restored = new PriorityQueue();
			restored.import(snapshot);

			expect(restored.dequeue("q")).toBe("high-1");
			expect(restored.dequeue("q")).toBe("high-2");
			expect(restored.dequeue("q")).toBe("low-1");
			expect(restored.dequeue("q")).toBe("low-2");
		});

		it("import resumes seq numbering past the highest restored value", () => {
			const q = new PriorityQueue();
			q.enqueue("q", "old-a", 5);
			q.enqueue("q", "old-b", 5);

			const snapshot = q.export();
			const restored = new PriorityQueue();
			restored.import(snapshot);

			// New entries at the same priority must come AFTER the restored
			// ones — which means seq must continue from the restored max.
			restored.enqueue("q", "new-a", 5);
			restored.enqueue("q", "new-b", 5);

			expect(restored.dequeue("q")).toBe("old-a");
			expect(restored.dequeue("q")).toBe("old-b");
			expect(restored.dequeue("q")).toBe("new-a");
			expect(restored.dequeue("q")).toBe("new-b");
		});

		it("export of an empty queue is empty", () => {
			expect(new PriorityQueue().export()).toEqual({});
		});
	});

	describe("performance sanity", () => {
		// Confirm the heap doesn't degrade: 50k enqueue+dequeue must
		// finish quickly. Pure-array implementations would be O(n^2).
		it("handles 50k enqueue/dequeue without blowing the time budget", () => {
			const q = new PriorityQueue();
			const n = 50_000;
			const start = Date.now();
			for (let i = 0; i < n; i++) q.enqueue("q", `v${i}`, i % 10);
			for (let i = 0; i < n; i++) q.dequeue("q");
			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(1000);
			expect(q.len("q")).toBe(0);
		});
	});
});
